import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { AuthUserDto } from "./auth-repository.ts";
import type { PaperOrderLegInput } from "./paper-repository.ts";
import { applyFillSlippage, validatePaperOrderCapacity } from "./paper-repository.ts";

const user: AuthUserDto = {
  id: "user-1",
  email: "trader@example.com",
  role: "SUBSCRIBER",
  emailVerified: true,
  disabled: false,
  allowedViews: []
};

function leg(overrides: Partial<PaperOrderLegInput> = {}): PaperOrderLegInput {
  return {
    underlyingSymbol: "NIFTY",
    expiry: "not-a-real-expiry-label", // resolves to no contractMonth -> fnoLotSize lookup is skipped, fallback lot size (65) used
    action: "SELL",
    optionType: "CE",
    strikePrice: 25000,
    lots: 1,
    requestedPrice: 100,
    stopLoss: 150,
    targetPrice: 50,
    strategyName: "test",
    ...overrides
  };
}

function mockClient(openPositions: { quantity: number; entryPrice: { toNumber: () => number } }[], pendingOrders: { quantity: number; requestedPrice: { toNumber: () => number } }[]) {
  return {
    paperPosition: { findMany: async () => openPositions },
    paperOrder: { findMany: async () => pendingOrders },
    fnoLotSize: { findUnique: async () => null }
  } as unknown as PrismaClient;
}

function decimal(value: number) {
  return { toNumber: () => value };
}

test("validatePaperOrderCapacity rejects a single order over the per-order lot cap", async () => {
  const message = await validatePaperOrderCapacity([leg({ lots: 51 })], user, mockClient([], []));
  assert.match(message ?? "", /51 lots exceeds the 50-lot/);
});

test("validatePaperOrderCapacity allows an order comfortably within every cap", async () => {
  const message = await validatePaperOrderCapacity([leg({ lots: 1, requestedPrice: 100 })], user, mockClient([], []));
  assert.equal(message, null);
});

test("validatePaperOrderCapacity rejects once open+pending positions would exceed the position cap", async () => {
  const openPositions = Array.from({ length: 20 }, () => ({ quantity: 65, entryPrice: decimal(10) }));
  const message = await validatePaperOrderCapacity([leg()], user, mockClient(openPositions, []));
  assert.match(message ?? "", /21, exceeding the 20-position/);
});

test("validatePaperOrderCapacity rejects once total notional would exceed the exposure cap", async () => {
  // 19 existing positions worth 65 * 1500 = 97,500 each -> 1,852,500 existing.
  // A new SELL leg of 1 lot (65 qty) at requestedPrice 3000 adds 195,000,
  // bringing the total to 2,047,500 > the 2,000,000 cap.
  const openPositions = Array.from({ length: 19 }, () => ({ quantity: 65, entryPrice: decimal(1500) }));
  const message = await validatePaperOrderCapacity([leg({ requestedPrice: 3000 })], user, mockClient(openPositions, []));
  assert.match(message ?? "", /exceeding the ₹20,00,000 paper-trading cap/);
});

test("validatePaperOrderCapacity counts pending orders toward both the position and notional caps, not just open positions", async () => {
  const pendingOrders = Array.from({ length: 20 }, () => ({ quantity: 65, entryPrice: decimal(10), requestedPrice: decimal(10) }));
  const message = await validatePaperOrderCapacity([leg()], user, mockClient([], pendingOrders));
  assert.match(message ?? "", /21, exceeding the 20-position/);
});

test("applyFillSlippage moves a BUY fill above the requested price and a SELL fill below it", () => {
  assert.ok(applyFillSlippage("BUY", 100) > 100, "a BUY should fill worse (higher) than requested, not exactly at it");
  assert.ok(applyFillSlippage("SELL", 100) < 100, "a SELL should fill worse (lower) than requested, not exactly at it");
});

test("applyFillSlippage is always against the trader, never in their favor", () => {
  for (const price of [10, 50, 100, 500, 2000]) {
    assert.ok(applyFillSlippage("BUY", price) > price);
    assert.ok(applyFillSlippage("SELL", price) < price);
  }
});
