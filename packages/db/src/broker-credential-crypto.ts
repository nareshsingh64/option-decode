// AES-256-GCM for broker access tokens at rest.
//
// A Dhan access token is a bearer credential that can place orders and move
// money. It lives 24 hours, which sounds reassuring and is not: 24 hours is
// plenty. So it is encrypted in the database, never returned by any route,
// never logged, and never emailed.
//
// GCM rather than CBC because it is authenticated - a tampered ciphertext fails
// to decrypt rather than silently producing garbage that then gets sent to a
// broker as an Authorization header.
//
// keyVersion is stored per row so the key can be rotated by re-encrypting row
// by row rather than by a migration and a flag day.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM-recommended nonce length
const KEY_BYTES = 32;

export const CURRENT_KEY_VERSION = 1;

export interface EncryptedToken {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export class BrokerCredentialCryptoError extends Error {}

/**
 * Resolve the encryption key.
 *
 * Deliberately throws rather than falling back to a default or a derived
 * constant. A "convenient" fallback key means tokens encrypted with a value
 * that is in the source tree, which is not encryption - and the failure would
 * be invisible, because everything would keep working.
 */
function resolveKey(keyVersion: number): Buffer {
  if (keyVersion !== CURRENT_KEY_VERSION) {
    throw new BrokerCredentialCryptoError(
      `No key configured for keyVersion ${keyVersion}. A credential encrypted with a retired key cannot be read; the user must re-paste their token.`
    );
  }

  const raw = process.env.LIVE_BROKER_ENCRYPTION_KEY;
  if (!raw) {
    throw new BrokerCredentialCryptoError(
      "LIVE_BROKER_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32"
    );
  }

  // Accept base64 or hex so the value can be produced by whichever tool is to
  // hand, but insist on exactly 32 bytes - a short key silently weakens
  // everything and node would happily accept a 16-byte one for aes-256 by
  // throwing only at cipher creation, which is a worse place to find out.
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    key = Buffer.from(raw.trim(), "hex");
  } else {
    key = Buffer.from(raw.trim(), "base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new BrokerCredentialCryptoError(
      `LIVE_BROKER_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. Generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

export function encryptBrokerToken(token: string): EncryptedToken {
  if (!token || !token.trim()) {
    throw new BrokerCredentialCryptoError("Refusing to encrypt an empty token.");
  }
  const key = resolveKey(CURRENT_KEY_VERSION);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token.trim(), "utf8"), cipher.final()]);
  return { cipher: encrypted, iv, tag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
}

export function decryptBrokerToken(encrypted: EncryptedToken): string {
  const key = resolveKey(encrypted.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv);
  decipher.setAuthTag(encrypted.tag);
  try {
    return Buffer.concat([decipher.update(encrypted.cipher), decipher.final()]).toString("utf8");
  } catch {
    // GCM authentication failed: wrong key, or the row was tampered with.
    // The original error text is not propagated - it says nothing useful and
    // there is a long history of crypto error strings leaking oracle-ish detail.
    throw new BrokerCredentialCryptoError(
      "Broker token failed to decrypt. The encryption key may have changed, or the stored credential is corrupt. The user must re-paste their token."
    );
  }
}

/**
 * Everything safe to show about a token: never the token.
 *
 * Not even to its owner, and not even masked beyond this. There is no product
 * reason to display a bearer credential back to a browser, and every reason a
 * displayed one ends up in a screenshot, a support ticket or a bug report.
 */
export interface BrokerTokenClaims {
  dhanClientId?: string;
  expiresAt?: Date;
  /** Only a token minted from Dhan Web (SELF, no partnerId) can be renewed. */
  renewable: boolean;
  tokenConsumerType?: string;
}

/**
 * Read the JWT claims without verifying the signature.
 *
 * We are not authenticating the token here - Dhan does that. We only need its
 * expiry and renewability so the UI can warn before it lapses. Note an `exp`
 * claim CANNOT know the token was revoked server-side: on 2026-08-17 every
 * renewal run cheerfully reported "10.98h remaining" about a credential that
 * had been dead since 08:20. Only a live /v2/fundlimit call proves liveness,
 * which is why verifiedAt exists on the row alongside tokenExpiresAt.
 */
export function readBrokerTokenClaims(token: string): BrokerTokenClaims {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { renewable: false };
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    const partnerId = typeof payload.partnerId === "string" ? payload.partnerId : "";
    const consumerType = typeof payload.tokenConsumerType === "string" ? payload.tokenConsumerType : undefined;
    return {
      dhanClientId: typeof payload.dhanClientId === "string" ? payload.dhanClientId : undefined,
      expiresAt: exp ? new Date(exp * 1000) : undefined,
      // A partner-minted token cannot be renewed, only regenerated at
      // web.dhan.co. Checking this at paste time - while the user is still at
      // the keyboard - beats discovering it from a failed cron at 08:17.
      renewable: consumerType === "SELF" && !partnerId,
      tokenConsumerType: consumerType
    };
  } catch {
    return { renewable: false };
  }
}
