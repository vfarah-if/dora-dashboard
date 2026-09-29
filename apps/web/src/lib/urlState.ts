import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { ReportRange } from "../api/hooks";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string | null) => (value && DATE.test(value) ? value : null);

/** The date range and bots flag held in the address, so a view can be shared as a link. */
export function useRangeParams(): [ReportRange, (next: ReportRange) => void] {
  const [params, setParams] = useSearchParams();
  const from = validDate(params.get("from"));
  const to = validDate(params.get("to"));
  const includeBots = params.get("bots") === "1";
  const range = useMemo(() => ({ from, to, includeBots }), [from, to, includeBots]);

  const setRange = useCallback(
    (next: ReportRange) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          const assign = (key: string, value: string | null) => (value ? updated.set(key, value) : updated.delete(key));
          assign("from", next.from);
          assign("to", next.to);
          assign("bots", next.includeBots ? "1" : null);
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return [range, setRange];
}

/** A boolean flag held in the address as `name=1`. */
export function useFlagParam(name: string): [boolean, (next: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) === "1";
  const setValue = useCallback(
    (next: boolean) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next) updated.set(name, "1");
          else updated.delete(name);
          return updated;
        },
        { replace: true },
      );
    },
    [name, setParams],
  );
  return [value, setValue];
}

/** A list of names held in the address as `name=a,b`, without blanks or duplicates. An empty list removes it. */
export function useListParam(name: string): [string[], (next: readonly string[]) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name);
  const value = useMemo(() => [...new Set((raw ?? "").split(",").map((part) => part.trim()))].filter(Boolean), [raw]);
  const setValue = useCallback(
    (next: readonly string[]) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next.length) updated.set(name, next.join(","));
          else updated.delete(name);
          return updated;
        },
        { replace: true },
      );
    },
    [name, setParams],
  );
  return [value, setValue];
}

/** Repository ids from `ids=1,2`, in the order given and without duplicates. */
export function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(ids)];
}
