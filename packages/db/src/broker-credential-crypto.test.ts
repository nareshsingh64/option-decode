import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import {
  BrokerCredentialCryptoError,
  decryptBrokerToken,
  encryptBrokerToken,
  readBrokerTokenClaims
} from "./broker-credential-crypto.js";

const TEST_KEY = randomBytes(32).toString("base64");
let savedKey: string | undefined;

before(() => {
  savedKey = process.env.LIVE_BROKER_ENCRYPTION_KEY;
  process.env.LIVE_BROKER_ENCRYPTION_KEY = TEST_KEY;
});

after(() => {
  if (savedKey === undefined) {
    delete process.env.LIVE_BROKER_ENCRYPTION_KEY;
  } else {
    process.env.LIVE_BROKER_ENCRYPTION_KEY = savedKey;
  }
});

// A realistic-shaped Dhan token: three base64url parts, renewable claims.
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${Buffer.from("sig").toString("base64url")}`;
}

test("a token round-trips through encrypt and decrypt", () => {
  const token = makeJwt({ dhanClientId: "1100000001", exp: 1788186306 });
  const encrypted = encryptBrokerToken(token);
  assert.equal(decryptBrokerToken(encrypted), token);
});

test("the ciphertext does not contain the plaintext", () => {
  const token = makeJwt({ dhanClientId: "1100000001", exp: 1788186306 });
  const encrypted = encryptBrokerToken(token);
  assert.ok(!encrypted.cipher.toString("utf8").includes("dhanClientId"));
  assert.ok(!encrypted.cipher.toString("base64").includes(token.slice(0, 24)));
});

test("every encryption uses a fresh IV", () => {
  // A reused nonce in GCM is catastrophic, not merely untidy - it leaks the
  // keystream. Two encryptions of the SAME token must differ.
  const token = makeJwt({ dhanClientId: "1100000001" });
  const a = encryptBrokerToken(token);
  const b = encryptBrokerToken(token);
  assert.notEqual(a.iv.toString("hex"), b.iv.toString("hex"));
  assert.notEqual(a.cipher.toString("hex"), b.cipher.toString("hex"));
});

test("a tampered ciphertext is rejected rather than silently decrypted", () => {
  // This is the whole reason for GCM over CBC. A corrupted credential must
  // fail loudly, not produce garbage that gets sent to a broker as a header.
  const encrypted = encryptBrokerToken(makeJwt({ dhanClientId: "1100000001" }));
  encrypted.cipher[0] = encrypted.cipher[0] ^ 0xff;
  assert.throws(() => decryptBrokerToken(encrypted), BrokerCredentialCryptoError);
});

test("a wrong key fails to decrypt instead of returning nonsense", () => {
  const encrypted = encryptBrokerToken(makeJwt({ dhanClientId: "1100000001" }));
  process.env.LIVE_BROKER_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    assert.throws(() => decryptBrokerToken(encrypted), BrokerCredentialCryptoError);
  } finally {
    process.env.LIVE_BROKER_ENCRYPTION_KEY = TEST_KEY;
  }
});

test("a missing or wrong-length key is refused, never defaulted", () => {
  // A fallback key would be a key living in the source tree, and the failure
  // would be invisible because everything would keep working.
  delete process.env.LIVE_BROKER_ENCRYPTION_KEY;
  assert.throws(() => encryptBrokerToken("x"), BrokerCredentialCryptoError);

  process.env.LIVE_BROKER_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
  assert.throws(() => encryptBrokerToken("x"), BrokerCredentialCryptoError);

  process.env.LIVE_BROKER_ENCRYPTION_KEY = TEST_KEY;
});

test("a hex key is accepted as well as base64", () => {
  process.env.LIVE_BROKER_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const token = makeJwt({ dhanClientId: "1100000001" });
  assert.equal(decryptBrokerToken(encryptBrokerToken(token)), token);
  process.env.LIVE_BROKER_ENCRYPTION_KEY = TEST_KEY;
});

test("an empty token is refused", () => {
  assert.throws(() => encryptBrokerToken(""), BrokerCredentialCryptoError);
  assert.throws(() => encryptBrokerToken("   "), BrokerCredentialCryptoError);
});

test("claims expose expiry and client id but the caller never needs the token", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims = readBrokerTokenClaims(makeJwt({ dhanClientId: "1100000001", exp, tokenConsumerType: "SELF", partnerId: "" }));
  assert.equal(claims.dhanClientId, "1100000001");
  assert.equal(claims.expiresAt?.getTime(), exp * 1000);
});

test("only a SELF token with no partnerId is renewable", () => {
  // The renewal script's preflight refuses a partner token rather than burning
  // it to find out; doing the same check at paste time is strictly better,
  // because the user is still there to fix it.
  assert.equal(readBrokerTokenClaims(makeJwt({ tokenConsumerType: "SELF", partnerId: "" })).renewable, true);
  assert.equal(readBrokerTokenClaims(makeJwt({ tokenConsumerType: "SELF", partnerId: "PARTNER1" })).renewable, false);
  assert.equal(readBrokerTokenClaims(makeJwt({ tokenConsumerType: "PARTNER", partnerId: "" })).renewable, false);
});

test("a non-JWT string yields no claims rather than throwing", () => {
  // Users paste all sorts of things. A malformed paste should be rejected by
  // the route with a clear message, not crash the parser.
  assert.deepEqual(readBrokerTokenClaims("not-a-jwt"), { renewable: false });
  assert.deepEqual(readBrokerTokenClaims("a.b.c"), { renewable: false });
});
