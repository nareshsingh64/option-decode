import { randomUUID } from "node:crypto";
import { getFallbackLotSize } from "@option-decode/types";
import type { OptionType } from "@option-decode/types";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { AuthUserDto } from "./auth-repository.js";
import { prisma } from "./index.js";
import { getStoredFnoLotSize } from "./lot-size-repository.js";

const DEMO_USER_EMAIL = "paper.demo@optiondecode.local";

export interface PaperOrderInput {
  underlyingSymbol: string;
  expiry: string;
  action: "BUY" | "SELL";
  optionType: OptionType;
  strikePrice: number;
  lots: number;
  requestedPrice: number;
  stopLoss: number;
  trailingStop?: boolean;
  trailDistance?: number;
  targetPrice: number;
  strategyName: string;
  reasonText?: string;
}

// A single leg within a multi-leg (hedge) order ticket. Extends the plain
// single-leg input with the leg's role - "MAIN" for the primary trade,
// "HEDGE" for any additional leg(s) added to protect it (e.g. a bought OTM
// option against a sold ATM/ITM option in the same ticket).
export interface PaperOrderLegInput extends PaperOrderInput {
  legRole?: "MAIN" | "HEDGE";
}

export interface PendingPaperOrderUpdateInput {
  lots: number;
  requestedPrice: number;
  stopLoss: number;
  trailingStop?: boolean;
  trailDistance?: number;
  targetPrice: number;
}

export interface PaperSummary {
  userId: string;
  orders: PaperOrderDto[];
  openPositions: PaperPositionDto[];
  openPositionGroups: PaperPositionGroupDto[];
  closedTrades: PaperTradeDto[];
  stats: {
    openPositions: number;
    filledOrders: number;
    pendingOrders: number;
    realizedPnl: number;
    markToMarketPnl: number;
  };
}

export interface PaperOrderDto {
  id: string;
  underlyingSymbol: string;
  expiry: string;
  action: string;
  optionType: OptionType;
  strikePrice: number;
  lots: number;
  lotSize: number;
  quantity: number;
  requestedPrice: number;
  filledPrice?: number;
  currentPrice?: number;
  stopLoss: number;
  trailingStop: boolean;
  trailDistance: number;
  targetPrice: number;
  status: string;
  strategyName: string;
  reasonText?: string;
  groupId?: string;
  legRole: string;
  // Informational only - estimated at placement time (works outside market
  // hours), unrelated to whether the order has filled yet.
  marginRequired?: number;
  marginBreakdown?: Record<string, unknown>;
  createdAt: string;
  ownerEmail?: string;
  ownerName?: string;
}

export interface PaperPositionDto {
  id: string;
  orderId: string;
  underlyingSymbol: string;
  expiry: string;
  action: string;
  optionType: OptionType;
  strikePrice: number;
  lots: number;
  lotSize: number;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  trailingStop: boolean;
  trailDistance: number;
  bestPrice: number;
  targetPrice: number;
  status: string;
  delta?: number;
  deltaExposure?: number;
  unrealizedPnl: number;
  openedAt: string;
  groupId?: string;
  legRole: string;
  // Informational only (Dhan margin calculator, captured at fill time). Not
  // used anywhere to block or size a trade - purely for the user's awareness.
  marginRequired?: number;
  marginBreakdown?: Record<string, unknown>;
  ownerEmail?: string;
  ownerName?: string;
}

// A leg that just transitioned PENDING -> FILLED during one
// monitorPaperTradingForSnapshot pass. Handed back to the worker (which owns
// the Dhan client) so it can best-effort fetch an informational margin
// figure and persist it via recordPositionMargin - paper-repository.ts
// itself has no Dhan dependency.
export interface FilledPaperLeg {
  positionId: string;
  groupId: string | null;
  legRole: string;
  underlyingSymbol: string;
  expiryLabel: string;
  optionType: OptionType;
  strikePrice: number;
  action: string;
  quantity: number;
  filledPrice: number;
  securityId?: string;
}

// One leg's worth of inputs needed to ask Dhan's margin calculator for a
// quote - either a filled position or a still-pending order, on its own or
// grouped with every other leg sharing a groupId (see
// getOpenPositionsForMarginGroup / getPendingOrdersForMarginGroup). `id` is
// whichever row (PaperPosition or PaperOrder) this leg came from.
export interface MarginQuoteLeg {
  id: string;
  underlyingSymbol: string;
  expiryLabel: string;
  optionType: OptionType;
  strikePrice: number;
  action: string;
  quantity: number;
  entryPrice: number;
  securityId?: string;
}

export interface PaperPositionGroupDto {
  underlyingSymbol: string;
  expiry: string;
  positions: number;
  lots: number;
  quantity: number;
  markToMarketPnl: number;
  deltaExposure: number;
}

export interface PaperTradeDto {
  id: string;
  positionId: string;
  underlyingSymbol: string;
  expiry: string;
  action: string;
  optionType: OptionType;
  strikePrice: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  targetPrice: number;
  lots: number;
  lotSize: number;
  quantity: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
  ownerEmail?: string;
  ownerName?: string;
}

export async function getPaperSummary(user: AuthUserDto, client: PrismaClient = prisma): Promise<PaperSummary> {
  const includeAllUsers = user.role === "ADMIN";
  const paperWhere = includeAllUsers ? realUserPaperWhere() : { userId: user.id };
  const positionWhere = includeAllUsers ? realUserPositionWhere() : { userId: user.id };
  const tradeWhere = includeAllUsers ? realUserTradeWhere() : { position: { userId: user.id } };
  await refreshPendingPaperOrders(paperWhere, client);
  await refreshOpenPositionPrices(positionWhere, client);

  const [orders, openPositions, closedTrades] = await Promise.all([
    client.paperOrder.findMany({
      where: paperWhere,
      include: paperUserInclude,
      orderBy: { createdAt: "desc" },
      take: 30
    }),
    client.paperPosition.findMany({
      where: { ...positionWhere, status: "OPEN" },
      include: paperUserInclude,
      orderBy: { openedAt: "desc" },
      take: 30
    }),
    client.paperTrade.findMany({
      where: tradeWhere,
      include: {
        position: {
          select: {
            user: {
              select: {
                email: true,
                displayName: true
              }
            },
            underlyingSymbol: true,
            expiryLabel: true,
            action: true,
            optionType: true,
            strikePrice: true,
            entryPrice: true,
            stopLoss: true,
            targetPrice: true,
            openedAt: true
          }
        }
      },
      orderBy: { closedAt: "desc" },
      take: 30
    })
  ]);

  const orderDtos = await Promise.all(orders.map((order) => mapOrder(order, client)));
  const positionDtos = await Promise.all(openPositions.map((position) => mapPosition(position, client)));
  const tradeDtos = await Promise.all(closedTrades.map((trade) => mapTrade(trade, client)));
  const openPositionGroups = buildOpenPositionGroups(positionDtos);

  return {
    userId: user.id,
    orders: orderDtos,
    openPositions: positionDtos,
    openPositionGroups,
    closedTrades: tradeDtos,
    stats: {
      openPositions: positionDtos.length,
      filledOrders: orderDtos.filter((order) => order.status === "FILLED").length,
      pendingOrders: orderDtos.filter((order) => order.status === "PENDING").length,
      realizedPnl: tradeDtos.reduce((total, trade) => total + trade.netPnl, 0),
      markToMarketPnl: positionDtos.reduce((total, position) => total + position.unrealizedPnl, 0)
    }
  };
}

async function buildPaperOrderCreateData(input: PaperOrderLegInput, userId: string, groupId: string | null, legRole: string, client: PrismaClient) {
  const now = new Date();
  const tradingDate = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const lotSize = await getPaperLotSize(input.underlyingSymbol, input.expiry, client);
  const quantity = input.lots * lotSize;
  const trailingStop = input.trailingStop ?? true;
  const requestedPrice = normalizeTradablePrice(input.requestedPrice);
  const trailDistance = normalizeTradablePrice(input.trailDistance ?? Math.abs(requestedPrice - input.stopLoss));
  const initialStopLoss = trailingStop ? getTrailingStopLoss(input.action, requestedPrice, trailDistance) : normalizeTradablePrice(input.stopLoss);
  const targetPrice = normalizeTradablePrice(input.targetPrice);

  return {
    userId,
    tradingDate,
    underlyingSymbol: input.underlyingSymbol,
    expiryLabel: input.expiry,
    action: input.action,
    optionType: input.optionType,
    strikePrice: input.strikePrice,
    quantity,
    requestedPrice,
    filledPrice: null,
    stopLoss: initialStopLoss,
    trailingStop,
    trailDistance,
    targetPrice,
    status: "PENDING" as const,
    strategyName: input.strategyName,
    reasonText: input.reasonText,
    groupId,
    legRole
  };
}

// Lightweight sizing guardrail. Unlike Sim's account/BPE model, this tab
// has no capital ledger at all - a user could place an unlimited number of
// positions at unlimited size across any expiry with zero constraint,
// confirmed live (153 real orders, 141 positions on file with no check
// anywhere). marginRequired/marginBreakdown already exist on every order
// and position, but are computed AFTER placement via an async, best-effort
// Dhan margin-calculator call that's deliberately allowed to fail without
// blocking the order (see tryEstimateOrderMargin in apps/api/src/
// server.ts) - not something available synchronously to gate on. Instead
// of adding a synchronous Dhan dependency to the placement path, this
// bounds total notional exposure and position count using data already on
// hand (lots, lot size, requested price) against fixed ceilings. Not a
// real capital balance - just enough to stop "unlimited" from being
// literal.
const MAX_LOTS_PER_ORDER = 50;
const MAX_OPEN_POSITIONS = 20;
// Rough retail paper-trading notional assumption, not tied to any real
// account - a ceiling on how much premium this practice book can carry
// open at once, summed across every existing position/pending order plus
// whatever this new ticket adds.
const MAX_NOTIONAL_EXPOSURE = 2_000_000;

// Checked before every order/leg is created. Returns null when within
// capacity, or a user-facing rejection reason otherwise.
export async function validatePaperOrderCapacity(legs: PaperOrderLegInput[], user: AuthUserDto, client: PrismaClient = prisma): Promise<string | null> {
  for (const leg of legs) {
    if (leg.lots > MAX_LOTS_PER_ORDER) {
      return `Order size ${leg.lots} lots exceeds the ${MAX_LOTS_PER_ORDER}-lot paper-trading cap.`;
    }
  }

  const [openPositions, pendingOrders, newLegQuantities] = await Promise.all([
    client.paperPosition.findMany({ where: { userId: user.id, status: "OPEN" }, select: { quantity: true, entryPrice: true } }),
    client.paperOrder.findMany({ where: { userId: user.id, status: "PENDING" }, select: { quantity: true, requestedPrice: true } }),
    Promise.all(legs.map(async (leg) => (await getPaperLotSize(leg.underlyingSymbol, leg.expiry, client)) * leg.lots))
  ]);

  const openPositionCount = openPositions.length + pendingOrders.length;
  if (openPositionCount + legs.length > MAX_OPEN_POSITIONS) {
    return `This would bring open/pending positions to ${openPositionCount + legs.length}, exceeding the ${MAX_OPEN_POSITIONS}-position paper-trading cap.`;
  }

  const existingNotional =
    openPositions.reduce((sum, position) => sum + position.quantity * position.entryPrice.toNumber(), 0) +
    pendingOrders.reduce((sum, order) => sum + order.quantity * order.requestedPrice.toNumber(), 0);
  const newNotional = legs.reduce((sum, leg, index) => sum + newLegQuantities[index] * leg.requestedPrice, 0);
  const totalNotional = existingNotional + newNotional;
  if (totalNotional > MAX_NOTIONAL_EXPOSURE) {
    return `This would bring total open notional to ~₹${Math.round(totalNotional).toLocaleString("en-IN")}, exceeding the ₹${MAX_NOTIONAL_EXPOSURE.toLocaleString("en-IN")} paper-trading cap.`;
  }

  return null;
}

// Returns the created order id alongside the refreshed summary so the API
// layer can compute a placement-time margin estimate for exactly this order
// without guessing which row in the summary is the one just created.
export async function placePaperOrder(input: PaperOrderInput, user: AuthUserDto, client: PrismaClient = prisma): Promise<{ summary: PaperSummary; orderId: string }> {
  const data = await buildPaperOrderCreateData(input, user.id, null, "MAIN", client);
  const order = await client.paperOrder.create({ data });

  return { summary: await getPaperSummary(user, client), orderId: order.id };
}

// Build multi-leg at entry: submit a main leg plus one or more hedge legs
// (e.g. a bought OTM option protecting a sold ATM/ITM option) in a single
// ticket. All legs are created together and linked via a shared groupId so
// they can be tracked/displayed as one strategy on the paper trading panel.
// Each leg still fills independently and asynchronously against its own
// requested price - there is no guarantee all legs fill at the same time.
export async function placeMultiLegPaperOrder(legs: PaperOrderLegInput[], user: AuthUserDto, client: PrismaClient = prisma): Promise<{ summary: PaperSummary; orderIds: string[] }> {
  if (legs.length === 0) {
    throw new Error("At least one leg is required to place a paper order.");
  }
  if (legs.length === 1) {
    const single = await placePaperOrder(legs[0], user, client);
    return { summary: single.summary, orderIds: [single.orderId] };
  }

  const groupId = randomUUID();
  const legData = await Promise.all(legs.map((leg, index) => buildPaperOrderCreateData(leg, user.id, groupId, leg.legRole ?? (index === 0 ? "MAIN" : "HEDGE"), client)));

  const createdOrders = await client.$transaction(legData.map((data) => client.paperOrder.create({ data })));

  return { summary: await getPaperSummary(user, client), orderIds: createdOrders.map((order) => order.id) };
}

export async function updatePendingPaperOrder(orderId: string, input: PendingPaperOrderUpdateInput, user: AuthUserDto, client: PrismaClient = prisma): Promise<PaperSummary> {
  const includeAllUsers = user.role === "ADMIN";
  const order = await client.paperOrder.findFirst({
    where: {
      id: orderId,
      ...(includeAllUsers ? {} : { userId: user.id }),
      status: "PENDING"
    }
  });

  if (!order) {
    throw new Error("Pending paper order was not found.");
  }

  const lotSize = await getPaperLotSize(order.underlyingSymbol, order.expiryLabel, client);
  const quantity = input.lots * lotSize;
  const trailingStop = input.trailingStop ?? order.trailingStop;
  const requestedPrice = normalizeTradablePrice(input.requestedPrice);
  const trailDistance = normalizeTradablePrice(input.trailDistance ?? Math.abs(requestedPrice - input.stopLoss));
  const stopLoss = trailingStop ? getTrailingStopLoss(order.action, requestedPrice, trailDistance) : normalizeTradablePrice(input.stopLoss);
  const targetPrice = normalizeTradablePrice(input.targetPrice);

  await client.paperOrder.update({
    where: { id: order.id },
    data: {
      quantity,
      requestedPrice,
      stopLoss,
      trailingStop,
      trailDistance,
      targetPrice
    }
  });

  return getPaperSummary(user, client);
}

export async function cancelPendingPaperOrder(orderId: string, user: AuthUserDto, client: PrismaClient = prisma): Promise<PaperSummary> {
  const includeAllUsers = user.role === "ADMIN";
  const order = await client.paperOrder.findFirst({
    where: {
      id: orderId,
      ...(includeAllUsers ? {} : { userId: user.id }),
      status: "PENDING"
    }
  });

  if (!order) {
    throw new Error("Pending paper order was not found.");
  }

  await client.paperOrder.update({
    where: { id: order.id },
    data: {
      status: "CANCELLED"
    }
  });

  return getPaperSummary(user, client);
}

export async function closePaperPosition(positionId: string, user: AuthUserDto, exitReason = "MANUAL", client: PrismaClient = prisma): Promise<PaperSummary> {
  const includeAllUsers = user.role === "ADMIN";
  await refreshOpenPositionPrices(includeAllUsers ? realUserPositionWhere() : { userId: user.id }, client);

  const position = await client.paperPosition.findFirst({
    where: {
      id: positionId,
      ...(includeAllUsers ? {} : { userId: user.id }),
      status: "OPEN"
    }
  });

  if (!position) {
    throw new Error("Open paper position was not found.");
  }

  const closed = await closePositionRecord(position, exitReason, client);
  if (!closed) {
    throw new Error("Position was already closed.");
  }

  return getPaperSummary(user, client);
}

export async function updatePaperPositionRisk(positionId: string, user: AuthUserDto, stopLoss: number, targetPrice: number, trailDistance?: number, trailingStop?: boolean, client: PrismaClient = prisma): Promise<PaperSummary> {
  const includeAllUsers = user.role === "ADMIN";
  const position = await client.paperPosition.findFirst({
    where: {
      id: positionId,
      ...(includeAllUsers ? {} : { userId: user.id }),
      status: "OPEN"
    }
  });

  if (!position) {
    throw new Error("Open paper position was not found.");
  }

  const entryPrice = position.entryPrice.toNumber();
  const currentPrice = position.currentPrice.toNumber();
  const nextStopLoss = normalizeTradablePrice(stopLoss);
  const nextTargetPrice = normalizeTradablePrice(targetPrice);
  const bestPrice = position.bestPrice?.toNumber() ?? currentPrice;
  const nextBestPrice = position.action === "BUY" ? Math.max(bestPrice, currentPrice, entryPrice) : Math.min(bestPrice, currentPrice, entryPrice);
  const nextTrailDistance = normalizeTradablePrice(trailDistance ?? Math.abs(nextBestPrice - nextStopLoss));
  // Preserve the position's existing trailing-stop setting unless the caller explicitly
  // says otherwise. This used to be hardcoded to `true`, which silently re-enabled
  // trailing on every risk save even for positions the user had switched to a fixed stop.
  const nextTrailingStop = trailingStop ?? position.trailingStop;

  if (position.action === "BUY" && nextTargetPrice <= entryPrice) {
    throw new Error("Target must be above entry price for BUY positions.");
  }
  if (position.action === "SELL" && nextTargetPrice >= entryPrice) {
    throw new Error("Target must be below entry price for SELL positions.");
  }

  await client.paperPosition.update({
    where: { id: position.id },
    data: {
      stopLoss: nextStopLoss,
      trailingStop: nextTrailingStop,
      trailDistance: nextTrailDistance,
      bestPrice: nextBestPrice,
      targetPrice: nextTargetPrice
    }
  });

  return getPaperSummary(user, client);
}

// Which expiries (for a given underlying) currently have a paper order or
// position depending on live price data - i.e. every expiry besides
// whichever one the worker's normal capture loop already tracks (the
// underlying's nearest expiry). Users can now place a paper trade against
// ANY expiry via the Paper Order Ticket's expiry picker, but the worker
// only ever fetched/stored live option-chain data for the nearest expiry -
// so a pending order or open position sitting on a later expiry had no
// live tick data to check against, showed no LTP, and could never fill.
// The worker calls this once per underlying per capture cycle and fetches
// live data for each expiry this returns too, alongside its usual nearest
// expiry.
export async function listExpiriesNeedingLiveData(underlyingSymbol: string, client: PrismaClient = prisma): Promise<string[]> {
  const [pendingOrders, openPositions] = await Promise.all([
    client.paperOrder.findMany({
      where: { underlyingSymbol, status: "PENDING" },
      select: { expiryLabel: true },
      distinct: ["expiryLabel"]
    }),
    client.paperPosition.findMany({
      where: { underlyingSymbol, status: "OPEN" },
      select: { expiryLabel: true },
      distinct: ["expiryLabel"]
    })
  ]);

  return [...new Set([...pendingOrders.map((order) => order.expiryLabel), ...openPositions.map((position) => position.expiryLabel)])];
}

export async function monitorPaperTradingForSnapshot(underlyingSymbol: string, expiryLabel: string, client: PrismaClient = prisma) {
  const orderWhere: Prisma.PaperOrderWhereInput = {
    ...realUserPaperWhere(),
    underlyingSymbol,
    expiryLabel
  };
  const positionWhere: Prisma.PaperPositionWhereInput = {
    ...realUserPositionWhere(),
    underlyingSymbol,
    expiryLabel
  };

  const orderResult = await refreshPendingPaperOrders(orderWhere, client);
  const positionResult = await refreshOpenPositionPrices(positionWhere, client);

  return {
    filledOrders: orderResult.filledCount,
    // Newly-filled legs from this pass, handed back so the caller (the
    // worker, which owns the Dhan client) can look up an informational
    // margin figure and persist it via recordPositionMargin. Empty on most
    // calls - only populated when a pending order actually fills.
    filledLegs: orderResult.filledLegs,
    checkedPositions: positionResult.checkedPositions,
    closedPositions: positionResult.closedPositions
  };
}

// Informational-only margin lookup support: given a position that just
// filled (or any position id), returns every OPEN position that should be
// priced together for a margin quote - i.e. every other leg sharing the
// same groupId (a multi-leg/hedge ticket), or just the position itself for
// an ordinary standalone trade. Includes each leg's latest known
// securityId so the caller can call Dhan's margin calculator.
export async function getOpenPositionsForMarginGroup(positionId: string, groupId: string | null | undefined, client: PrismaClient = prisma): Promise<MarginQuoteLeg[]> {
  const positions = groupId ? await client.paperPosition.findMany({ where: { groupId, status: "OPEN" } }) : await client.paperPosition.findMany({ where: { id: positionId, status: "OPEN" } });

  return Promise.all(
    positions.map(async (position) => {
      const latestTick = await client.optionContractTick.findFirst({
        where: {
          underlyingSymbol: position.underlyingSymbol,
          expiryLabel: position.expiryLabel,
          optionType: position.optionType,
          strikePrice: position.strikePrice
        },
        orderBy: { tickTime: "desc" }
      });

      return {
        id: position.id,
        underlyingSymbol: position.underlyingSymbol,
        expiryLabel: position.expiryLabel,
        optionType: position.optionType,
        strikePrice: position.strikePrice.toNumber(),
        action: position.action,
        quantity: position.quantity,
        entryPrice: position.entryPrice.toNumber(),
        securityId: latestTick?.securityId ?? undefined
      };
    })
  );
}

// Informational-only margin lookup support for orders that haven't filled
// yet: given a just-placed order, returns every PENDING order that should
// be priced together for a margin quote (every other leg sharing the same
// groupId, or just the order itself for an ordinary single-leg ticket).
// Uses the requested price (there's no fill price yet) and whatever the
// latest known securityId is for that contract - deliberately not filtered
// by tick freshness, since this needs to work outside market hours (Dhan's
// margin calculator is a static SPAN/exposure lookup, not a live quote).
export async function getPendingOrdersForMarginGroup(orderId: string, groupId: string | null | undefined, client: PrismaClient = prisma): Promise<MarginQuoteLeg[]> {
  const orders = groupId ? await client.paperOrder.findMany({ where: { groupId, status: "PENDING" } }) : await client.paperOrder.findMany({ where: { id: orderId, status: "PENDING" } });

  return Promise.all(
    orders.map(async (order) => {
      const latestTick = await client.optionContractTick.findFirst({
        where: {
          underlyingSymbol: order.underlyingSymbol,
          expiryLabel: order.expiryLabel,
          optionType: order.optionType,
          strikePrice: order.strikePrice
        },
        orderBy: { tickTime: "desc" }
      });

      return {
        id: order.id,
        underlyingSymbol: order.underlyingSymbol,
        expiryLabel: order.expiryLabel,
        optionType: order.optionType,
        strikePrice: order.strikePrice.toNumber(),
        action: order.action,
        quantity: order.quantity,
        entryPrice: order.requestedPrice.toNumber(),
        securityId: latestTick?.securityId ?? undefined
      };
    })
  );
}

// Persists the informational margin figure onto every position in a group
// (denormalized on purpose - lets the UI show "margin required" per row
// without a join). Never throws on a bad/missing Dhan response; the caller
// is expected to treat margin lookup as best-effort and skip this call on
// failure rather than fail the fill.
export async function recordPositionMargin(positionIds: string[], marginRequired: number, marginBreakdown: Record<string, unknown>, client: PrismaClient = prisma): Promise<void> {
  if (positionIds.length === 0) {
    return;
  }
  await client.paperPosition.updateMany({
    where: { id: { in: positionIds } },
    data: { marginRequired, marginBreakdown: marginBreakdown as Prisma.InputJsonValue }
  });
}

// Same as recordPositionMargin, but for still-pending orders - the
// order-placement-time margin estimate (see getPendingOrdersForMarginGroup).
export async function recordOrderMargin(orderIds: string[], marginRequired: number, marginBreakdown: Record<string, unknown>, client: PrismaClient = prisma): Promise<void> {
  if (orderIds.length === 0) {
    return;
  }
  await client.paperOrder.updateMany({
    where: { id: { in: orderIds } },
    data: { marginRequired, marginBreakdown: marginBreakdown as Prisma.InputJsonValue }
  });
}

async function refreshPendingPaperOrders(where: Prisma.PaperOrderWhereInput, client: PrismaClient) {
  const pendingOrders = await client.paperOrder.findMany({
    where: {
      ...where,
      status: "PENDING"
    },
    orderBy: { createdAt: "asc" }
  });

  const results = await Promise.all(
    pendingOrders.map(async (order) => {
      const latestTick = await client.optionContractTick.findFirst({
        where: {
          underlyingSymbol: order.underlyingSymbol,
          expiryLabel: order.expiryLabel,
          optionType: order.optionType,
          strikePrice: order.strikePrice
        },
        orderBy: { tickTime: "desc" }
      });

      const latestPrice = latestTick?.lastPrice?.toNumber();
      if (latestPrice === undefined || !shouldFillPaperOrder(order.action, order.requestedPrice.toNumber(), latestPrice)) {
        return null;
      }

      const filledPrice = normalizeTradablePrice(applyFillSlippage(order.action, order.requestedPrice.toNumber()));
      const trailDistance = normalizeTradablePrice(order.trailDistance?.toNumber() ?? Math.abs(filledPrice - order.stopLoss.toNumber()));
      const stopLoss = order.trailingStop ? getTrailingStopLoss(order.action, filledPrice, trailDistance) : normalizeTradablePrice(order.stopLoss.toNumber());
      const targetPrice = normalizeTradablePrice(order.targetPrice.toNumber());
      const now = new Date();

      return client.$transaction(async (tx) => {
        // Conditional update: only proceeds if this order is still PENDING at the moment
        // the write is applied. This is the atomicity guard that prevents two concurrent
        // callers (e.g. the worker's snapshot monitor and a browser's summary poll landing
        // at the same moment) from both creating a position for the same order.
        const updateResult = await tx.paperOrder.updateMany({
          where: { id: order.id, status: "PENDING" },
          data: {
            status: "FILLED",
            filledPrice,
            stopLoss,
            trailDistance,
            targetPrice
          }
        });

        if (updateResult.count === 0) {
          // Another concurrent request already filled or cancelled this order.
          return null;
        }

        const position = await tx.paperPosition.create({
          data: {
            userId: order.userId,
            orderId: order.id,
            tradingDate: order.tradingDate,
            underlyingSymbol: order.underlyingSymbol,
            expiryLabel: order.expiryLabel,
            action: order.action,
            optionType: order.optionType,
            strikePrice: order.strikePrice,
            quantity: order.quantity,
            entryPrice: filledPrice,
            currentPrice: filledPrice,
            stopLoss,
            trailingStop: order.trailingStop,
            trailDistance,
            bestPrice: filledPrice,
            targetPrice,
            status: "OPEN",
            realizedPnl: 0,
            openedAt: now,
            // Carry the order's leg-grouping onto the resulting position so
            // hedge legs stay linked once they're live positions.
            groupId: order.groupId,
            legRole: order.legRole
          }
        });

        const filledLeg: FilledPaperLeg = {
          positionId: position.id,
          groupId: order.groupId,
          legRole: order.legRole,
          underlyingSymbol: order.underlyingSymbol,
          expiryLabel: order.expiryLabel,
          optionType: order.optionType,
          strikePrice: order.strikePrice.toNumber(),
          action: order.action,
          quantity: order.quantity,
          filledPrice,
          securityId: latestTick?.securityId ?? undefined
        };

        return filledLeg;
      });
    })
  );

  const filledLegs = results.filter((result): result is FilledPaperLeg => Boolean(result));
  return { filledCount: filledLegs.length, filledLegs };
}

async function refreshOpenPositionPrices(where: Prisma.PaperPositionWhereInput, client: PrismaClient) {
  const positions = await client.paperPosition.findMany({
    where: {
      ...where,
      status: "OPEN"
    }
  });
  const scoreSignalCache = new Map<string, Promise<number>>();
  const getCachedScoreSignal = (underlyingSymbol: string, expiryLabel: string) => {
    const key = `${underlyingSymbol}:${expiryLabel}`;
    const existing = scoreSignalCache.get(key);
    if (existing) {
      return existing;
    }
    const pending = getAtmWindowScoreSignal(underlyingSymbol, expiryLabel, client);
    scoreSignalCache.set(key, pending);
    return pending;
  };

  const results = await Promise.all(
    positions.map(async (position) => {
      const latestTick = await client.optionContractTick.findFirst({
        where: {
          underlyingSymbol: position.underlyingSymbol,
          expiryLabel: position.expiryLabel,
          optionType: position.optionType,
          strikePrice: position.strikePrice
        },
        orderBy: { tickTime: "desc" }
      });

      if (!latestTick?.lastPrice) {
        return { checked: true, closed: false };
      }

      const latestPrice = latestTick.lastPrice.toNumber();
      const currentStopLoss = position.stopLoss.toNumber();
      const targetPrice = position.targetPrice.toNumber();
      const isBuy = position.action === "BUY";
      const trailDistance = normalizeTradablePrice(position.trailDistance?.toNumber() ?? Math.abs(position.entryPrice.toNumber() - currentStopLoss));
      const currentBestPrice = position.bestPrice?.toNumber() ?? position.entryPrice.toNumber();
      const nextBestPrice = isBuy ? Math.max(currentBestPrice, latestPrice) : Math.min(currentBestPrice, latestPrice);
      const scoreSignal = position.trailingStop ? await getCachedScoreSignal(position.underlyingSymbol, position.expiryLabel) : 0;

      // A single noisy 30s-cycle reading against the position used to
      // tighten the stop straight to breakeven (or trail tight) instantly,
      // and since the stop only ever ratchets tighter, a one-off blip that
      // reversed the very next cycle left the position permanently stuck
      // at that tight level. Now a danger reading only takes effect once
      // it's held for DANGER_STREAK_REQUIRED consecutive cycles in a row -
      // a genuine reversal still gets caught, just not a single flicker.
      // Favorable (profit-locking) readings are unaffected - they apply
      // immediately as before, since that's the wanted behavior.
      const isDangerNow = position.trailingStop && isTradeSignalDanger(position.action, position.optionType, scoreSignal);
      // Incremented atomically in the database rather than read-modify-
      // written from `position`, which was loaded earlier in this pass. Two
      // concurrent callers (the worker's 30s tick and a browser summary
      // poll landing together) could otherwise each read the same streak
      // value and write back the same +1, losing one increment and pushing
      // the confirmation an extra cycle away - which is precisely the
      // debounce this streak exists to provide. The update returns the
      // post-increment value, so the stop calculation below reads the true
      // streak rather than this pass's stale estimate; a plain reset to 0
      // needs no atomicity since it's idempotent.
      const { dangerSignalStreak: nextDangerStreak } = await client.paperPosition.update({
        where: { id: position.id },
        data: { dangerSignalStreak: isDangerNow ? { increment: 1 } : 0 },
        select: { dangerSignalStreak: true }
      });
      const dangerConfirmed = nextDangerStreak >= DANGER_STREAK_REQUIRED;
      const effectiveScoreSignal = isDangerNow && !dangerConfirmed ? 0 : scoreSignal;

      const nextStopLoss = position.trailingStop ? getDynamicTrailingStopLoss(position.action, position.optionType, position.entryPrice.toNumber(), latestPrice, targetPrice, nextBestPrice, trailDistance, effectiveScoreSignal) : currentStopLoss;
      const stopLoss = position.trailingStop ? (isBuy ? Math.max(currentStopLoss, nextStopLoss) : Math.min(currentStopLoss, nextStopLoss)) : currentStopLoss;
      const hitStop = isBuy ? latestPrice <= stopLoss : latestPrice >= stopLoss;
      const hitTarget = isBuy ? latestPrice >= targetPrice : latestPrice <= targetPrice;

      await client.paperPosition.update({
        where: { id: position.id },
        data: {
          currentPrice: latestPrice,
          stopLoss: normalizeTradablePrice(stopLoss),
          trailDistance,
          bestPrice: nextBestPrice
          // dangerSignalStreak is already persisted atomically above.
        }
      });

      if (hitStop || hitTarget) {
        const updatedPosition = await client.paperPosition.findUnique({
          where: { id: position.id }
        });

        if (updatedPosition?.status === "OPEN") {
          const closed = await closePositionRecord(updatedPosition, hitTarget ? "TARGET" : "STOP_LOSS", client);
          if (closed) {
            return { checked: true, closed: true };
          }
        }
      }

      return { checked: true, closed: false };
    })
  );

  return {
    checkedPositions: results.filter((result) => result.checked).length,
    closedPositions: results.filter((result) => result.closed).length
  };
}

async function closePositionRecord(
  position: {
    id: string;
    entryPrice: Prisma.Decimal;
    currentPrice: Prisma.Decimal;
    quantity: number;
    action: string;
  },
  exitReason: string,
  client: PrismaClient
): Promise<boolean> {
  const entryPrice = position.entryPrice.toNumber();
  const exitPrice = position.currentPrice.toNumber();
  const direction = position.action === "BUY" ? 1 : -1;
  const grossPnl = (exitPrice - entryPrice) * position.quantity * direction;
  const charges = Math.max(1, Math.abs(exitPrice * position.quantity) * 0.0005);
  const netPnl = grossPnl - charges;
  const now = new Date();

  return client.$transaction(async (tx) => {
    // Conditional update: only proceeds if this position is still OPEN at the moment
    // the write is applied, preventing a manual "Exit" click from racing with the
    // worker's automatic stop-loss/target close (or two concurrent refreshes) into
    // creating two paperTrade rows for the same position.
    const updateResult = await tx.paperPosition.updateMany({
      where: { id: position.id, status: "OPEN" },
      data: {
        status: "CLOSED",
        realizedPnl: netPnl,
        closedAt: now,
        exitReason
      }
    });

    if (updateResult.count === 0) {
      // Another concurrent request already closed this position.
      return false;
    }

    await tx.paperTrade.create({
      data: {
        positionId: position.id,
        entryPrice,
        exitPrice,
        quantity: position.quantity,
        grossPnl,
        charges,
        netPnl,
        exitReason,
        closedAt: now
      }
    });

    return true;
  });
}

async function mapOrder(
  order: {
  id: string;
  underlyingSymbol: string;
  expiryLabel: string;
  action: string;
  optionType: OptionType;
  strikePrice: Prisma.Decimal;
  quantity: number;
  requestedPrice: Prisma.Decimal;
  filledPrice: Prisma.Decimal | null;
  stopLoss: Prisma.Decimal;
  trailingStop: boolean;
  trailDistance: Prisma.Decimal | null;
  targetPrice: Prisma.Decimal;
  status: string;
  strategyName: string;
  reasonText: string | null;
  groupId?: string | null;
  legRole?: string | null;
  marginRequired?: Prisma.Decimal | null;
  marginBreakdown?: Prisma.JsonValue | null;
  createdAt: Date;
  user?: {
    email: string;
    displayName: string | null;
  };
},
  client: PrismaClient
): Promise<PaperOrderDto> {
  const lotSize = await getPaperLotSize(order.underlyingSymbol, order.expiryLabel, client);
  const latestPrice = await getLatestPaperOrderPrice(order, client);
  return {
    id: order.id,
    underlyingSymbol: order.underlyingSymbol,
    expiry: order.expiryLabel,
    action: order.action,
    optionType: order.optionType,
    strikePrice: order.strikePrice.toNumber(),
    lots: lotsFromQuantity(order.quantity, lotSize),
    lotSize,
    quantity: order.quantity,
    requestedPrice: normalizeTradablePrice(order.requestedPrice.toNumber()),
    filledPrice: order.filledPrice ? normalizeTradablePrice(order.filledPrice.toNumber()) : undefined,
    currentPrice: latestPrice === undefined ? undefined : normalizeTradablePrice(latestPrice),
    stopLoss: normalizeTradablePrice(order.stopLoss.toNumber()),
    trailingStop: order.trailingStop,
    trailDistance: normalizeTradablePrice(order.trailDistance?.toNumber() ?? Math.abs(order.requestedPrice.toNumber() - order.stopLoss.toNumber())),
    targetPrice: normalizeTradablePrice(order.targetPrice.toNumber()),
    status: order.status,
    strategyName: order.strategyName,
    reasonText: order.reasonText ?? undefined,
    groupId: order.groupId ?? undefined,
    legRole: order.legRole ?? "MAIN",
    marginRequired: order.marginRequired ? order.marginRequired.toNumber() : undefined,
    marginBreakdown: (order.marginBreakdown as Record<string, unknown> | null) ?? undefined,
    createdAt: order.createdAt.toISOString(),
    ownerEmail: order.user?.email,
    ownerName: order.user?.displayName ?? undefined
  };
}

async function mapPosition(
  position: {
  id: string;
  orderId: string;
  underlyingSymbol: string;
  expiryLabel: string;
  action: string;
  optionType: OptionType;
  strikePrice: Prisma.Decimal;
  quantity: number;
  entryPrice: Prisma.Decimal;
  currentPrice: Prisma.Decimal;
  stopLoss: Prisma.Decimal;
  trailingStop: boolean;
  trailDistance: Prisma.Decimal | null;
  bestPrice: Prisma.Decimal | null;
  targetPrice: Prisma.Decimal;
  status: string;
  openedAt: Date;
  groupId?: string | null;
  legRole?: string | null;
  marginRequired?: Prisma.Decimal | null;
  marginBreakdown?: Prisma.JsonValue | null;
  user?: {
    email: string;
    displayName: string | null;
  };
},
  client: PrismaClient
): Promise<PaperPositionDto> {
  const entryPrice = position.entryPrice.toNumber();
  const currentPrice = position.currentPrice.toNumber();
  const direction = position.action === "BUY" ? 1 : -1;
  const lotSize = await getPaperLotSize(position.underlyingSymbol, position.expiryLabel, client);
  const latestTick = await getLatestPaperOptionTick(position, client);
  const delta = latestTick?.deltaValue?.toNumber();
  const deltaExposure = delta === undefined ? undefined : delta * position.quantity * direction;

  return {
    id: position.id,
    orderId: position.orderId,
    underlyingSymbol: position.underlyingSymbol,
    expiry: position.expiryLabel,
    action: position.action,
    optionType: position.optionType,
    strikePrice: position.strikePrice.toNumber(),
    lots: lotsFromQuantity(position.quantity, lotSize),
    lotSize,
    quantity: position.quantity,
    entryPrice,
    currentPrice,
    stopLoss: normalizeTradablePrice(position.stopLoss.toNumber()),
    trailingStop: position.trailingStop,
    trailDistance: normalizeTradablePrice(position.trailDistance?.toNumber() ?? Math.abs(entryPrice - position.stopLoss.toNumber())),
    bestPrice: position.bestPrice?.toNumber() ?? currentPrice,
    targetPrice: normalizeTradablePrice(position.targetPrice.toNumber()),
    status: position.status,
    delta,
    deltaExposure,
    unrealizedPnl: (currentPrice - entryPrice) * position.quantity * direction,
    openedAt: position.openedAt.toISOString(),
    groupId: position.groupId ?? undefined,
    legRole: position.legRole ?? "MAIN",
    marginRequired: position.marginRequired ? position.marginRequired.toNumber() : undefined,
    marginBreakdown: (position.marginBreakdown as Record<string, unknown> | null) ?? undefined,
    ownerEmail: position.user?.email,
    ownerName: position.user?.displayName ?? undefined
  };
}

function buildOpenPositionGroups(positions: PaperPositionDto[]): PaperPositionGroupDto[] {
  const groups = new Map<string, PaperPositionGroupDto>();

  for (const position of positions) {
    const key = `${position.underlyingSymbol}:${position.expiry}`;
    const group = groups.get(key) ?? {
      underlyingSymbol: position.underlyingSymbol,
      expiry: position.expiry,
      positions: 0,
      lots: 0,
      quantity: 0,
      markToMarketPnl: 0,
      deltaExposure: 0
    };

    group.positions += 1;
    group.lots += position.lots;
    group.quantity += position.quantity;
    group.markToMarketPnl += position.unrealizedPnl;
    group.deltaExposure += position.deltaExposure ?? 0;
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => {
    const symbolCompare = left.underlyingSymbol.localeCompare(right.underlyingSymbol);
    return symbolCompare || left.expiry.localeCompare(right.expiry);
  });
}

async function mapTrade(
  trade: {
  id: string;
  positionId: string;
  exitPrice: Prisma.Decimal;
  quantity: number;
  grossPnl: Prisma.Decimal;
  charges: Prisma.Decimal;
  netPnl: Prisma.Decimal;
  exitReason: string;
  closedAt: Date;
  position: {
    underlyingSymbol: string;
    expiryLabel: string;
    action: string;
    optionType: OptionType;
    strikePrice: Prisma.Decimal;
    entryPrice: Prisma.Decimal;
    stopLoss: Prisma.Decimal;
    targetPrice: Prisma.Decimal;
    openedAt: Date;
    user?: {
      email: string;
      displayName: string | null;
    };
  };
},
  client: PrismaClient
): Promise<PaperTradeDto> {
  const lotSize = await getPaperLotSize(trade.position.underlyingSymbol, trade.position.expiryLabel, client);
  return {
    id: trade.id,
    positionId: trade.positionId,
    underlyingSymbol: trade.position.underlyingSymbol,
    expiry: trade.position.expiryLabel,
    action: trade.position.action,
    optionType: trade.position.optionType,
    strikePrice: trade.position.strikePrice.toNumber(),
    entryPrice: trade.position.entryPrice.toNumber(),
    exitPrice: trade.exitPrice.toNumber(),
    stopLoss: normalizeTradablePrice(trade.position.stopLoss.toNumber()),
    targetPrice: normalizeTradablePrice(trade.position.targetPrice.toNumber()),
    lots: lotsFromQuantity(trade.quantity, lotSize),
    lotSize,
    quantity: trade.quantity,
    grossPnl: trade.grossPnl.toNumber(),
    charges: trade.charges.toNumber(),
    netPnl: trade.netPnl.toNumber(),
    exitReason: trade.exitReason,
    openedAt: trade.position.openedAt.toISOString(),
    closedAt: trade.closedAt.toISOString(),
    ownerEmail: trade.position.user?.email,
    ownerName: trade.position.user?.displayName ?? undefined
  };
}

async function getPaperLotSize(underlyingSymbol: string, expiry: string, client: PrismaClient) {
  return (await getStoredFnoLotSize(underlyingSymbol, expiry, client)) ?? getFallbackLotSize(underlyingSymbol);
}

async function getLatestPaperOrderPrice(
  order: {
    underlyingSymbol: string;
    expiryLabel: string;
    optionType: OptionType;
    strikePrice: Prisma.Decimal;
  },
  client: PrismaClient
) {
  const latestTick = await client.optionContractTick.findFirst({
    where: {
      underlyingSymbol: order.underlyingSymbol,
      expiryLabel: order.expiryLabel,
      optionType: order.optionType,
      strikePrice: order.strikePrice
    },
    orderBy: { tickTime: "desc" }
  });

  return latestTick?.lastPrice?.toNumber();
}

async function getLatestPaperOptionTick(
  option: {
    underlyingSymbol: string;
    expiryLabel: string;
    optionType: OptionType;
    strikePrice: Prisma.Decimal;
  },
  client: PrismaClient
) {
  return client.optionContractTick.findFirst({
    where: {
      underlyingSymbol: option.underlyingSymbol,
      expiryLabel: option.expiryLabel,
      optionType: option.optionType,
      strikePrice: option.strikePrice
    },
    orderBy: { tickTime: "desc" },
    select: {
      deltaValue: true
    }
  });
}


function lotsFromQuantity(quantity: number, lotSize: number) {
  return Math.max(1, Math.round(quantity / lotSize));
}

// Number of consecutive refreshOpenPositionPrices cycles (~30s apart) the
// danger signal must hold before it's allowed to actually tighten a
// position's stop - see the call site in refreshOpenPositionPrices for the
// full reasoning. 3 cycles is roughly 60-90s of confirmation depending on
// snapshot timing jitter.
const DANGER_STREAK_REQUIRED = 3;

function getTrailingStopLoss(action: string, referencePrice: number, trailDistance: number) {
  const rawStopLoss = action === "BUY" ? Math.max(0, referencePrice - trailDistance) : referencePrice + trailDistance;
  return normalizeTradablePrice(rawStopLoss);
}

function getDynamicTrailingStopLoss(action: string, optionType: OptionType, entryPrice: number, latestPrice: number, targetPrice: number, bestPrice: number, trailDistance: number, scoreSignal: number) {
  if (isTradeSignalDanger(action, optionType, scoreSignal)) {
    return hasMovedInFavor(action, entryPrice, latestPrice) ? normalizeTradablePrice(entryPrice) : getTrailingStopLoss(action, bestPrice, trailDistance);
  }

  if (isTradeSignalFavorable(action, optionType, scoreSignal)) {
    const targetMove = Math.abs(targetPrice - entryPrice);
    const achievedMove = action === "BUY" ? latestPrice - entryPrice : entryPrice - latestPrice;
    const progress = targetMove > 0 ? achievedMove / targetMove : 0;

    if (progress >= 0.85) {
      return normalizeTradablePrice(action === "BUY" ? entryPrice + targetMove * 0.75 : entryPrice - targetMove * 0.75);
    }
    if (progress >= 0.75) {
      return normalizeTradablePrice(action === "BUY" ? entryPrice + targetMove * 0.5 : entryPrice - targetMove * 0.5);
    }
    if (progress >= 0.5) {
      // Scaled to targetMove like the tiers above (was a hardcoded "+3 points" that ignored
      // the instrument's actual premium scale, giving back nearly all gains on higher-priced
      // contracts before the halfway profit-lock kicked in).
      return normalizeTradablePrice(action === "BUY" ? entryPrice + targetMove * 0.25 : Math.max(0, entryPrice - targetMove * 0.25));
    }
  }

  return getTrailingStopLoss(action, bestPrice, trailDistance);
}

function isTradeSignalFavorable(action: string, optionType: OptionType, scoreSignal: number) {
  if (scoreSignal === 0) {
    return false;
  }
  const bullishSignal = scoreSignal > 0;
  if (action === "BUY") {
    return optionType === "CE" ? bullishSignal : !bullishSignal;
  }
  return optionType === "CE" ? !bullishSignal : bullishSignal;
}

function isTradeSignalDanger(action: string, optionType: OptionType, scoreSignal: number) {
  if (scoreSignal === 0) {
    return false;
  }
  return !isTradeSignalFavorable(action, optionType, scoreSignal);
}

function hasMovedInFavor(action: string, entryPrice: number, latestPrice: number) {
  return action === "BUY" ? latestPrice > entryPrice : latestPrice < entryPrice;
}

async function getAtmWindowScoreSignal(underlyingSymbol: string, expiryLabel: string, client: PrismaClient) {
  // Resolve expiryLabel -> expiryId first rather than filtering
  // OptionChainSnapshot through the nested expiry relation directly - the
  // latter prevents MySQL from using the [underlyingSymbol, expiryId,
  // snapshotTime] composite index (confirmed via EXPLAIN in production on
  // the identical pattern in market-repository.ts), turning a single-row
  // lookup into a scan of thousands of rows. Expiry itself is tiny, so
  // this extra lookup is effectively free.
  const expiry = await client.expiry.findFirst({
    where: {
      expiryLabel,
      underlying: { symbol: underlyingSymbol }
    },
    select: { id: true }
  });
  if (!expiry) {
    return 0;
  }

  const snapshot = await client.optionChainSnapshot.findFirst({
    where: {
      underlyingSymbol,
      expiryId: expiry.id
    },
    include: {
      ticks: true
    },
    orderBy: { snapshotTime: "desc" }
  });

  if (!snapshot) {
    return 0;
  }

  const atmStrike = snapshot.atmStrike.toNumber();
  const strikes = [...new Set(snapshot.ticks.map((tick) => tick.strikePrice.toNumber()))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === atmStrike);
  if (atmIndex < 0) {
    return 0;
  }

  const lotSize = await getPaperLotSize(underlyingSymbol, expiryLabel, client);
  const signal = strikes.slice(Math.max(0, atmIndex - 2), atmIndex + 3).reduce((total, strike) => {
    const pe = snapshot.ticks.find((tick) => tick.strikePrice.toNumber() === strike && tick.optionType === "PE");
    const ce = snapshot.ticks.find((tick) => tick.strikePrice.toNumber() === strike && tick.optionType === "CE");
    return total + strikeTrendScore(pe, lotSize) - strikeTrendScore(ce, lotSize);
  }, 0);

  return Math.abs(signal) >= 8 ? Math.sign(signal) : 0;
}

function strikeTrendScore(
  tick?: {
    changeInOpenInterest: Prisma.Decimal | null;
    volume: Prisma.Decimal | null;
  } | null,
  lotSize = 1
) {
  if (!tick) {
    return 0;
  }
  return Math.round(toLots(tick.changeInOpenInterest?.toNumber(), lotSize) + toLots(tick.volume?.toNumber(), lotSize) * 0.05);
}

function toLots(value: number | undefined, lotSize: number | undefined) {
  return (value ?? 0) / (lotSize && lotSize > 0 ? lotSize : 1);
}

const paperUserInclude = {
  user: {
    select: {
      email: true,
      displayName: true
    }
  }
};

function realUserPaperWhere(): Prisma.PaperOrderWhereInput {
  return {
    user: {
      email: {
        not: DEMO_USER_EMAIL
      }
    }
  };
}

function realUserPositionWhere(): Prisma.PaperPositionWhereInput {
  return {
    user: {
      email: {
        not: DEMO_USER_EMAIL
      }
    }
  };
}

function realUserTradeWhere(): Prisma.PaperTradeWhereInput {
  return {
    position: {
      user: {
        email: {
          not: DEMO_USER_EMAIL
        }
      }
    }
  };
}

function shouldFillPaperOrder(action: string, entryPrice: number, latestPrice: number) {
  return action === "BUY" ? latestPrice <= entryPrice : latestPrice >= entryPrice;
}

// A limit order filled at exactly its requested price the instant the
// market crossed it - no spread, no size-dependent slippage, no partial
// fills - in direct contrast to Sim's chi/spread-driven fill model in the
// same app (packages/db/src/sim-repository.ts). A trader mainly using
// this simpler tab (it's the default "Paper Trading" nav item) was being
// taught systematically better execution than they'll ever actually get.
// This is a fixed-percentage approximation, not Sim's full bid-ask-driven
// chi model - this tab's fill loop only ever fetches lastPrice, not
// bid/ask, and porting the full model would mean fetching and reasoning
// about spread data this simpler order lifecycle doesn't otherwise use.
// Applied against the trader in both directions: a BUY fills slightly
// above its requested price, a SELL slightly below.
const PAPER_FILL_SLIPPAGE_PERCENT = 0.5;

export function applyFillSlippage(action: string, requestedPrice: number): number {
  const factor = action === "BUY" ? 1 + PAPER_FILL_SLIPPAGE_PERCENT / 100 : 1 - PAPER_FILL_SLIPPAGE_PERCENT / 100;
  return requestedPrice * factor;
}

function normalizeTradablePrice(value: number, tickSize = 0.05) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Number((Math.ceil((value - 1e-9) / tickSize) * tickSize).toFixed(2));
}
