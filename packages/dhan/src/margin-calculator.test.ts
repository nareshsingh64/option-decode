import assert from "node:assert/strict";
import { test } from "node:test";

import { DhanClient, type DhanMarginLegInput } from "./index.js";

// Guards the request field names on POST /v2/margincalculator/multi.
//
// This is a spelling test, which normally would not be worth writing. It is
// here because the spelling was wrong in two places for the entire life of the
// feature and nothing anywhere noticed: `scripts` instead of `scripList`, and
// `includeOrders` instead of `includeOrder`. The evidence was 195 PaperOrder
// rows and 180 PaperPosition rows in production, every one of them carrying a
// NULL marginRequired - not a zero, never populated at all.
//
// It failed silently by design. Both call sites (apps/api/src/server.ts and
// apps/worker/src/worker.ts) wrap this in a try/catch that logs at warn level
// and continues, because a margin figure is informational and must never block
// a fill. That is the right behaviour for the feature and it is exactly what
// hid the bug: a rejected request looks identical to "Dhan was busy".
//
// Dhan's documentation cannot settle the names - the curl example and the
// structured spec on the same docs page disagree with each other. The official
// Python client is the authority: dhan-oss/DhanHQ-py, src/dhanhq/_funds.py,
// margin_calculator_multi() builds { includePosition, includeOrder, scripList }.
//
// The trap for anyone "tidying" this later: `includePosition` really is
// singular while the flag beside it really is `includeOrder`, also singular,
// yet the array is `scripList`. There is no consistent rule to infer from.
// Pluralising either flag reintroduces the bug, and no test other than this one
// would fail.

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

// Stubs global fetch, returns what the client sent. Restores on the way out
// even if the assertion throws, so one failing test cannot cascade.
async function captureRequest(
  legs: DhanMarginLegInput[],
  response: Record<string, unknown> = { total_margin: 178392, currency: "INR" }
): Promise<Captured> {
  const realFetch = globalThis.fetch;
  let captured: Captured | undefined;

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    captured = {
      url: String(input),
      body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>
    };
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify(response)
    };
  }) as unknown as typeof globalThis.fetch;

  try {
    const client = new DhanClient({
      baseUrl: "https://api.dhan.co",
      clientId: "TESTCLIENT",
      // Deliberately not a JWT: assertAccessTokenIsUsable() returns early for
      // anything that is not three dot-separated parts, so this never trips the
      // expiry check and the test needs no live credential.
      accessToken: "not-a-jwt-token"
    });
    await client.calculateMultiOrderMargin(legs, "test:margin-fields");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(captured, "fetch was never called");
  return captured;
}

const TWO_LEG_SPREAD: DhanMarginLegInput[] = [
  { transactionType: "SELL", quantity: 30, securityId: "69801", price: 300, productType: "MARGIN" },
  { transactionType: "BUY", quantity: 30, securityId: "69838", price: 150, productType: "MARGIN" }
];

test("the legs array is sent as scripList, not scripts", async () => {
  const { body } = await captureRequest(TWO_LEG_SPREAD);

  assert.ok(
    Array.isArray(body.scripList),
    `legs must be sent as "scripList"; body keys were ${JSON.stringify(Object.keys(body))}`
  );
  assert.equal(
    body.scripts,
    undefined,
    '"scripts" is the name that silently returned nothing - see the header comment'
  );
  assert.equal((body.scripList as unknown[]).length, 2);
});

test("the pending-orders flag is includeOrder, not includeOrders", async () => {
  const { body } = await captureRequest(TWO_LEG_SPREAD);

  assert.equal(body.includeOrder, false, '"includeOrder" is singular');
  assert.equal(
    body.includeOrders,
    undefined,
    '"includeOrders" is the plural typo that read as correct beside includePosition'
  );
  // Singular here too, and correct already - asserted so a future "consistency"
  // pass that pluralises everything fails loudly rather than silently.
  assert.equal(body.includePosition, false, '"includePosition" is singular');
});

test("legs keep their per-leg segment and product type", async () => {
  const { body } = await captureRequest([
    { transactionType: "SELL", quantity: 1, securityId: "576434", price: 40, exchangeSegment: "MCX_COMM", productType: "MARGIN" }
  ]);

  const [leg] = body.scripList as Array<Record<string, unknown>>;
  assert.equal(leg.exchangeSegment, "MCX_COMM", "an MCX leg must not be defaulted to NSE_FNO");
  assert.equal(leg.productType, "MARGIN", "an explicit product type must survive the mapping");
  assert.equal(leg.securityId, "576434");
  assert.equal(leg.quantity, 1);
});

test("the request reaches the multi endpoint and carries the client id", async () => {
  const { url, body } = await captureRequest(TWO_LEG_SPREAD);

  assert.equal(url, "https://api.dhan.co/v2/margincalculator/multi");
  assert.equal(body.dhanClientId, "TESTCLIENT");
});

test("an empty basket is rejected before any request is made", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should never be reached");
  }) as unknown as typeof globalThis.fetch;

  try {
    const client = new DhanClient({ baseUrl: "https://api.dhan.co", clientId: "TESTCLIENT", accessToken: "not-a-jwt-token" });
    await assert.rejects(() => client.calculateMultiOrderMargin([], "test:margin-fields"));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(called, false, "an empty basket must not cost a Dhan request");
});

test("the response is decoded from Dhan's snake_case field names", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200,
    ok: true,
    text: async () =>
      JSON.stringify({
        total_margin: 222711.6,
        span_margin: 0,
        exposure_margin: 0,
        equity_margin: 0,
        fo_margin: 222711.6,
        commodity_margin: 0,
        currency: "INR",
        hedge_benefit: "44319.60"
      })
  })) as unknown as typeof globalThis.fetch;

  try {
    const client = new DhanClient({ baseUrl: "https://api.dhan.co", clientId: "TESTCLIENT", accessToken: "not-a-jwt-token" });
    const result = await client.calculateMultiOrderMargin(TWO_LEG_SPREAD, "test:margin-fields");
    assert.equal(result.totalMargin, 222711.6);
    assert.equal(result.foMargin, 222711.6);
    assert.equal(result.currency, "INR");
    assert.equal(result.hedgeBenefit, "44319.60");
  } finally {
    globalThis.fetch = realFetch;
  }
});
