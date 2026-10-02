export interface DeviceCode {
  /** Secret half of the pair. Stays on the server and is never sent to the browser. */
  deviceCode: string;
  /** The short code the person types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Seconds until the pair stops working. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

export type DevicePoll =
  { status: "pending" | "slow_down" | "expired" | "denied"; interval?: number } | { status: "granted"; token: string };

/**
 * Signs a person in through a code host's device flow, with no client secret.
 *
 * `start` asks for a fresh code pair and throws UpstreamError when the host refuses.
 * `poll` makes one attempt to exchange the device code and reports the outcome as data:
 * `pending` (keep waiting), `slow_down` (wait longer, `interval` carries the new wait in seconds
 * when the host gave one), `expired`, `denied` or `granted` with the access token. Any other
 * refusal, such as a misconfigured client, throws UpstreamError with the host's own reason.
 * Callers must respect the interval; the port itself does not wait or retry.
 */
export interface DeviceAuthorisation {
  start(): Promise<DeviceCode>;
  poll(deviceCode: string): Promise<DevicePoll>;
}
