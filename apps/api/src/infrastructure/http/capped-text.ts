import { UpstreamError } from "../../core/errors.js";

/**
 * Reads a response body as text, refusing at once when it declares more than `max` bytes and stopping when it streams
 * more. `who` names the system in the message, which never carries an address.
 */
export async function readCappedText(response: Response, max: number, who: string): Promise<string> {
  const tooLarge = () => new UpstreamError(`${who} sent a reply larger than the limit`, 502);
  const declared = Number(response.headers.get("content-length"));
  if (response.headers.get("content-length") && Number.isFinite(declared) && declared > max) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof UpstreamError) throw error;
    // A timeout that fires while the body streams is a slow upstream, not a broken connection.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new UpstreamError(`${who} did not finish sending its reply in time`, 504, { cause: error });
    }
    throw new UpstreamError(`The reply from ${who} was interrupted`, 502, { cause: error });
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The JSON value in `text`, of any shape, or an `UpstreamError` naming `who` when it is not valid JSON. */
export function parseJsonValue(text: string, who: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UpstreamError(`${who} sent a reply that is not valid JSON`, 502, { cause: error });
  }
}

/** The JSON object in `text`, or an `UpstreamError` naming `who` when it is not valid JSON or not an object. */
export function parseJsonObject(text: string, who: string): Record<string, unknown> {
  const value = parseJsonValue(text, who);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UpstreamError(`${who} sent a reply that is not a JSON object`, 502);
  }
  return value as Record<string, unknown>;
}
