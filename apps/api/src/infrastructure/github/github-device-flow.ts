import { UpstreamError } from "../../core/errors.js";
import type { DeviceAuthorisation, DeviceCode, DevicePoll } from "../../interfaces/device-authorisation.js";

const CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SLOW_DOWN_PENALTY_SECONDS = 5;

interface CodeBody {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenBody {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

function isHttps(address: string): boolean {
  try {
    return new URL(address).protocol === "https:";
  } catch {
    return false;
  }
}

/** GitHub's OAuth device flow. It needs only the public client ID, never a secret. */
export class GitHubDeviceFlow implements DeviceAuthorisation {
  constructor(
    private readonly clientId: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async post<T>(url: string, body: Record<string, string>): Promise<{ body: T; status: number }> {
    const response = await this.http(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, ...body }),
    });
    try {
      return { body: (await response.json()) as T, status: response.status };
    } catch {
      throw new UpstreamError("GitHub sent an unreadable sign-in response", response.status);
    }
  }

  async start(): Promise<DeviceCode> {
    const { body, status } = await this.post<CodeBody>(CODE_URL, { scope: "repo read:org" });
    if (!body.device_code || !body.user_code || !body.verification_uri) {
      throw new UpstreamError(body.error_description ?? "GitHub did not start the sign-in", status);
    }
    if (!isHttps(body.verification_uri)) throw new UpstreamError("GitHub sent a sign-in address that is not https", status);
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in ?? 900,
      interval: body.interval ?? SLOW_DOWN_PENALTY_SECONDS,
    };
  }

  async poll(deviceCode: string): Promise<DevicePoll> {
    const { body, status } = await this.post<TokenBody>(TOKEN_URL, { device_code: deviceCode, grant_type: GRANT_TYPE });
    if (body.access_token) return { status: "granted", token: body.access_token };
    switch (body.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return body.interval === undefined ? { status: "slow_down" } : { status: "slow_down", interval: body.interval };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      default:
        throw new UpstreamError(body.error_description ?? body.error ?? "GitHub did not issue a token", status);
    }
  }
}
