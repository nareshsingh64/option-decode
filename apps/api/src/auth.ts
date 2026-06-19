import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthUserDto } from "@option-decode/db";

const SESSION_COOKIE_NAME = "option_decode_session";
const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString("base64url");
  return `pbkdf2:${PASSWORD_ITERATIONS}:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [scheme, iterationsText, salt, hash] = storedHash.split(":");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2" || !Number.isFinite(iterations) || !salt || !hash) {
    return false;
  }

  const candidate = pbkdf2Sync(password, salt, iterations, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
  const expected = Buffer.from(hash, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createSessionCookie(user: AuthUserDto, secret: string) {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ userId: user.id, expiresAt })).toString("base64url");
  const signature = signSessionPayload(payload, secret);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

export function createClearedSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function getSessionUserId(cookieHeader: string | undefined, secret: string) {
  const session = parseCookies(cookieHeader)[SESSION_COOKIE_NAME];
  if (!session) {
    return undefined;
  }

  const [payload, signature] = session.split(".");
  if (!payload || !signature || signSessionPayload(payload, secret) !== signature) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { userId?: string; expiresAt?: number };
    if (!decoded.userId || !decoded.expiresAt || decoded.expiresAt < Date.now()) {
      return undefined;
    }
    return decoded.userId;
  } catch {
    return undefined;
  }
}

function signSessionPayload(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function parseCookies(cookieHeader: string | undefined) {
  return Object.fromEntries(
    String(cookieHeader ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        return separatorIndex >= 0 ? [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)] : [part, ""];
      })
  );
}
