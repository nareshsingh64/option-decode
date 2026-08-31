// Dhan partner consent login - the browser flow that replaces pasting a JWT.
//
// This is a DIFFERENT surface from DhanClient. It lives on auth.dhan.co rather
// than api.dhan.co, authenticates with partner_id/partner_secret headers rather
// than a per-user access-token, and its whole purpose is to MINT the token that
// DhanClient then uses. Keeping it in its own module rather than bolting it onto
// DhanClient avoids a client that sometimes has a user token and sometimes has
// partner credentials, which is the kind of ambiguity that ends up sending the
// wrong header to the wrong host.
//
//   POST /partner/generate-consent   -> consentId
//   (browser) /consent-login?consentId=...   user logs in with 2FA
//   (redirect) your URL ?tokenId=...
//   GET  /partner/consume-consent?tokenId=... -> accessToken + dhanClientId
//
// IMPORTANT, and established by probing rather than from the docs: a token
// minted this way is NOT renewable. /v2/RenewToken only extends a token created
// from Dhan Web (tokenConsumerType SELF, empty partnerId), and the renewal
// script's preflight refuses a partner token rather than burning one to find
// out. So partner-issued credentials are re-consented, never renewed - which is
// cheap, because re-consenting is a few clicks rather than hunting for a JWT.

const DEFAULT_AUTH_BASE_URL = "https://auth.dhan.co";

export interface DhanPartnerOptions {
  partnerId: string;
  partnerSecret: string;
  /** Where Dhan sends the user back. Must be registered with Dhan. */
  redirectUrl: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export interface DhanConsent {
  consentId: string;
  /** Send the user here. They authenticate with Dhan directly; we never see it. */
  loginUrl: string;
}

export interface DhanConsumedConsent {
  accessToken: string;
  dhanClientId: string;
  dhanClientName?: string;
  dhanClientUcc?: string;
  expiryTime?: string;
}

export class DhanPartnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DhanPartnerError";
  }
}

export class DhanPartnerClient {
  constructor(private readonly options: DhanPartnerOptions) {}

  private get baseUrl(): string {
    return this.options.baseUrl ?? DEFAULT_AUTH_BASE_URL;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      partner_id: this.options.partnerId,
      partner_secret: this.options.partnerSecret
    };
  }

  /**
   * Step 1. Ask Dhan for a consent, and build the URL the user logs in at.
   *
   * Dhan caps consent creation at 25 per day per partner, so this should be
   * called when a user actually starts the flow - never speculatively on page
   * load, or a handful of users idling on the panel exhausts the day's budget.
   */
  async generateConsent(): Promise<DhanConsent> {
    const raw = await this.request<Record<string, unknown>>("POST", "/partner/generate-consent");
    const consentId = String(raw.consentId ?? raw.consentAppId ?? "");
    if (!consentId) {
      throw new DhanPartnerError("Dhan returned no consentId. Check the partner id and secret.");
    }
    return {
      consentId,
      loginUrl: `${this.baseUrl}/consent-login?consentId=${encodeURIComponent(consentId)}`
    };
  }

  /**
   * Step 3. Exchange the tokenId from the redirect for the real access token.
   *
   * The returned token is a live credential from this moment on. The caller must
   * encrypt it before it touches storage and must never log it - see
   * broker-credential-crypto.ts. This method deliberately does not log its own
   * response body for that reason.
   */
  async consumeConsent(tokenId: string): Promise<DhanConsumedConsent> {
    if (!tokenId.trim()) {
      throw new DhanPartnerError("consumeConsent needs the tokenId from the redirect.");
    }
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      `/partner/consume-consent?tokenId=${encodeURIComponent(tokenId.trim())}`
    );
    const accessToken = String(raw.accessToken ?? "");
    const dhanClientId = String(raw.dhanClientId ?? "");
    if (!accessToken || !dhanClientId) {
      // Deliberately does not include the body: on a partial response it may
      // still carry a usable token, and this message goes to logs.
      throw new DhanPartnerError(
        "Dhan's consume-consent response carried no access token or client id. The tokenId may already have been used - each one is single-use."
      );
    }
    return {
      accessToken,
      dhanClientId,
      dhanClientName: typeof raw.dhanClientName === "string" ? raw.dhanClientName : undefined,
      dhanClientUcc: typeof raw.dhanClientUcc === "string" ? raw.dhanClientUcc : undefined,
      expiryTime: typeof raw.expiryTime === "string" ? raw.expiryTime : undefined
    };
  }

  private async request<T>(method: "GET" | "POST", path: string): Promise<T> {
    if (!this.options.partnerId || !this.options.partnerSecret) {
      throw new DhanPartnerError(
        "Partner login is not configured. Set DHAN_PARTNER_ID and DHAN_PARTNER_SECRET."
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DhanPartnerError(`Dhan partner request ${path} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let decoded: unknown;
    try {
      decoded = text ? JSON.parse(text) : {};
    } catch {
      throw new DhanPartnerError(`Dhan partner request ${path} returned non-JSON HTTP ${response.status}.`);
    }
    if (!response.ok) {
      // The status and Dhan's own message are useful; the body is not echoed
      // wholesale because a consume-consent response can contain a token.
      const message =
        typeof decoded === "object" && decoded !== null && "errorMessage" in decoded
          ? String((decoded as Record<string, unknown>).errorMessage)
          : `HTTP ${response.status}`;
      throw new DhanPartnerError(`Dhan partner request ${path} failed: ${message}`);
    }
    return decoded as T;
  }
}

/** True when partner login can be offered at all. */
export function isPartnerLoginConfigured(options: Partial<DhanPartnerOptions>): boolean {
  return Boolean(options.partnerId && options.partnerSecret && options.redirectUrl);
}
