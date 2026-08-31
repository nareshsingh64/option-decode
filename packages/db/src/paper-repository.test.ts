import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { AuthUserDto } from "./auth-repository.ts";
import type { PaperOrderLegInput } from "./paper-repository.ts";
import { applyFillSlippage, settleExpiredPaperPositions, validatePaperOrderCapacity } from "./paper-repository.ts";

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

// --- Expiry settlement -------------------------------------------------
//
// The live case these are built from: a SILVER 188000 CE sold at 34,415.60,
// quantity 30, on the 2026-08-28 expiry. MCX settled at 23:30 IST (18:00 UTC)
// with spot 236,703, so the short call was 48,703 in the money - while its
// last traded print was a stale 34,588.50. Settling at the print instead of at
// intrinsic understates the loss 82x, and in the flattering direction.
const SILVER_POSITION = {
  id: "pos-silver",
  underlyingSymbol: "SILVER",
  expiryLabel: "2026-08-28",
  optionType: "CE" as const,
  strikePrice: decimal(188_000),
  entryPrice: decimal(34_415.6),
  currentPrice: decimal(34_588.5),
  quantity: 30,
  action: "SELL",
  status: "OPEN"
};

function settlementClient(
  positions: unknown[],
  snapshots: { snapshotTime: Date; spotPrice: { toNumber: () => number } }[],
  pendingOrders: unknown[] = []
) {
  const closed: { id: string; exitReason: string; exitPrice: number; realizedPnl: number }[] = [];
  const cancelledOrderIds: string[] = [];
  const client = {
    paperPosition: {
      findMany: async () => positions,
      updateMany: async ({ where, data }: { where: { id: string }; data: { exitReason: string; currentPrice: number; realizedPnl: number } }) => {
        closed.push({ id: where.id, exitReason: data.exitReason, exitPrice: data.currentPrice, realizedPnl: data.realizedPnl });
        return { count: 1 };
      }
    },
    paperOrder: {
      findMany: async () => pendingOrders,
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        cancelledOrderIds.push(...where.id.in);
        return { count: where.id.in.length };
      }
    },
    paperTrade: { create: async () => ({}) },
    // Only snapshots at or before the settlement moment are eligible; the
    // filter is the function's own, so the mock hands back everything and
    // lets it choose.
    optionChainSnapshot: {
      findFirst: async ({ where }: { where: { snapshotTime: { lte: Date } } }) => {
        const eligible = snapshots.filter((snapshot) => snapshot.snapshotTime.getTime() <= where.snapshotTime.lte.getTime()).sort((left, right) => right.snapshotTime.getTime() - left.snapshotTime.getTime());
        return eligible[0] ?? null;
      }
    },
    $transaction: async (callback: (tx: unknown) => Promise<boolean>) => callback(client)
  };
  return { client: client as unknown as PrismaClient, closed, cancelledOrderIds };
}

test("settleExpiredPaperPositions prices an expired short at intrinsic, not at its last traded price", async () => {
  const { client, closed } = settlementClient(
    [SILVER_POSITION],
    [{ snapshotTime: new Date("2026-08-28T17:59:30.000Z"), spotPrice: decimal(236_703) }]
  );

  const result = await settleExpiredPaperPositions(new Date("2026-08-31T05:00:00.000Z"), client);

  assert.equal(result.settledPositions, 1);
  assert.equal(closed[0].exitReason, "EXPIRED_ITM");
  assert.equal(closed[0].exitPrice, 48_703);
  // The stale print would have booked roughly -5,187 instead.
  assert.ok(closed[0].realizedPnl < -420_000, `expected a six-figure loss, got ${closed[0].realizedPnl}`);
});

test("settleExpiredPaperPositions ignores a spot printed after the contract stopped trading", async () => {
  // 18:00:42 UTC is 42 seconds past the MCX close - a real snapshot from the
  // stranded position's own history. Settlement must not use it, nor any of
  // the days of spot movement that followed.
  const { client, closed } = settlementClient(
    [SILVER_POSITION],
    [
      { snapshotTime: new Date("2026-08-28T17:59:30.000Z"), spotPrice: decimal(236_703) },
      { snapshotTime: new Date("2026-08-28T18:00:42.000Z"), spotPrice: decimal(236_651) },
      { snapshotTime: new Date("2026-08-31T04:00:00.000Z"), spotPrice: decimal(999_999) }
    ]
  );

  await settleExpiredPaperPositions(new Date("2026-08-31T05:00:00.000Z"), client);
  assert.equal(closed[0].exitPrice, 48_703);
});

test("settleExpiredPaperPositions leaves a contract that is still trading alone", async () => {
  // 15:45 IST on expiry day, when the first EOD pass runs. MCX has nearly
  // eight hours left, which is what the second 23:40 pass exists for.
  const { client, closed } = settlementClient(
    [SILVER_POSITION],
    [{ snapshotTime: new Date("2026-08-28T09:00:00.000Z"), spotPrice: decimal(236_703) }]
  );

  const result = await settleExpiredPaperPositions(new Date("2026-08-28T10:15:00.000Z"), client);
  assert.equal(result.settledPositions, 0);
  assert.equal(closed.length, 0);
});

test("settleExpiredPaperPositions settles an OTM short at zero", async () => {
  const { client, closed } = settlementClient(
    [{ ...SILVER_POSITION, strikePrice: decimal(300_000) }],
    [{ snapshotTime: new Date("2026-08-28T17:59:30.000Z"), spotPrice: decimal(236_703) }]
  );

  await settleExpiredPaperPositions(new Date("2026-08-31T05:00:00.000Z"), client);
  assert.equal(closed[0].exitReason, "EXPIRED_WORTHLESS");
  assert.equal(closed[0].exitPrice, 0);
});

test("settleExpiredPaperPositions skips rather than guesses when no spot was captured before settlement", async () => {
  // Settling at a guessed price writes a wrong realised P&L that nothing later
  // corrects; leaving the position OPEN keeps it visible and exitable by hand.
  const { client, closed } = settlementClient([SILVER_POSITION], []);

  const result = await settleExpiredPaperPositions(new Date("2026-08-31T05:00:00.000Z"), client);
  assert.equal(result.skippedPositions, 1);
  assert.equal(result.settledPositions, 0);
  assert.equal(closed.length, 0);
});

test("settleExpiredPaperPositions cancels a pending order on a dead contract but not on a live one", async () => {
  const { client, cancelledOrderIds } = settlementClient(
    [],
    [],
    [
      { id: "order-dead", underlyingSymbol: "SILVER", expiryLabel: "2026-08-28" },
      { id: "order-live", underlyingSymbol: "NIFTY", expiryLabel: "2026-09-08" }
    ]
  );

  const result = await settleExpiredPaperPositions(new Date("2026-08-31T05:00:00.000Z"), client);
  assert.equal(result.cancelledOrders, 1);
  assert.deepEqual(cancelledOrderIds, ["order-dead"]);
});
