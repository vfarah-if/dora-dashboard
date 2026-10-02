import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, errorText } from "./client";
import { queryKeys } from "./hooks";
import type { AuthState, DevicePoll, DeviceStart } from "./hooks";

export type DeviceFlowState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; start: DeviceStart }
  | { phase: "expired" }
  | { phase: "denied" }
  | { phase: "incomplete" }
  | { phase: "error"; message: string };

const MIN_INTERVAL_SECONDS = 1;
export const MAX_POLL_FAILURES = 3;

/** A network failure or a server error may pass; a client error will not. */
const isTransient = (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status >= 500);
const toMs = (seconds: number) => Math.max(Number.isFinite(seconds) ? seconds : 0, MIN_INTERVAL_SECONDS) * 1000;

/**
 * Drives the GitHub device code sign-in. Polling waits the interval before every request, follows the latest
 * interval the API returns, and stops on a terminal status, an error or unmount.
 */
export function useDeviceFlow() {
  const client = useQueryClient();
  const [state, setState] = useState<DeviceFlowState>({ phase: "idle" });
  const [attempt, setAttempt] = useState(0);
  const waitingStart = state.phase === "waiting" ? state.start : null;

  const start = useCallback(async () => {
    setState({ phase: "starting" });
    try {
      const begun = await apiRequest<DeviceStart>("/api/auth/device", { method: "POST" });
      setState({ phase: "waiting", start: begun });
      setAttempt((n) => n + 1);
    } catch (error) {
      setState({ phase: "error", message: errorText(error) });
    }
  }, []);

  useEffect(() => {
    if (!waitingStart) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let seconds = waitingStart.interval;
    const schedule = (seconds: number) => {
      timer = setTimeout(() => void poll(), toMs(seconds));
    };
    const poll = async () => {
      try {
        const result = await apiRequest<DevicePoll>("/api/auth/device/poll", { method: "POST" });
        if (cancelled) return;
        failures = 0;
        if (result.status === "pending") {
          seconds = result.interval;
          schedule(seconds);
        } else if (result.status === "granted") {
          await client.invalidateQueries({ queryKey: queryKeys.me });
          if (!cancelled && !client.getQueryData<AuthState>(queryKeys.me)?.user) setState({ phase: "incomplete" });
        } else setState({ phase: result.status });
      } catch (error) {
        if (cancelled) return;
        failures += 1;
        if (isTransient(error) && failures < MAX_POLL_FAILURES) schedule(seconds);
        else setState({ phase: "error", message: errorText(error) });
      }
    };
    schedule(waitingStart.interval);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // A new attempt restarts the loop even when the API hands back an identical code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, client]);

  return { state, start };
}
