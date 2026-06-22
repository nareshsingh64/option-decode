import type { OptionType } from "@option-decode/types";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { AuthUserDto } from "./auth-repository.js";
import { prisma } from "./index.js";
import { getStoredFnoLotSize } from "./lot-size-repository.js";

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
  unrealizedPnl: number;
  openedAt: string;
  ownerEmail?: string;
  ownerName?: string;
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
  const paperWhere = includeAllUsers ? {} : { userId: user.id };
  const tradeWhere = includeAllUsers ? {} : { position: { userId: user.id } };
  await refreshPendingPaperOrders(includeAllUsers ? undefined : user.id, client);
  await refreshOpenPositionPrices(includeAllUsers ? undefined : user.id, client);

  const [orders, openPositions, closedTrades] = await Promise.all([
    client.paperOrder.findMany({
      where: paperWhere,
      include: paperUserInclude,
      orderBy: { createdAt: "desc" },
      take: 30
    }),
    client.paperPosition.findMany({
      where: { ...paperWhere, status: "OPEN" },
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

  return {
    userId: user.id,
    orders: orderDtos,
    openPositions: positionDtos,
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

export async function placePaperOrder(input: PaperOrderInput, user: AuthUserDto, client: PrismaClient = prisma): Promise<PaperSummary> {
  const now = new Date();
  const tradingDate = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const lotSize = await getPaperLotSize(input.underlyingSymbol, input.expiry, client);
  const quantity = input.lots * lotSize;
  const trailingStop = input.trailingStop ?? true;
  const requestedPrice = normalizeTradablePrice(input.requestedPrice);
  const trailDistance = normalizeTradablePrice(input.trailDistance ?? Math.abs(requestedPrice - input.stopLoss));
  const initialStopLoss = trailingStop ? getTrailingStopLoss(input.action, requestedPrice, trailDistance) : normalizeTradablePrice(input.stopLoss);
  const targetPrice = normalizeTradablePrice(input.targetPrice);

  await client.paperOrder.create({
    data: {
      userId: user.id,
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
      status: "PENDING",
      strategyName: input.strategyName,
      reasonText: input.reasonText
    }
  });

  return getPaperSummary(user, client);
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
  await refreshOpenPositionPrices(includeAllUsers ? undefined : user.id, client);

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

  await closePositionRecord(position, exitReason, client);

  return getPaperSummary(user, client);
}

export async function updatePaperPositionRisk(positionId: string, user: AuthUserDto, stopLoss: number, targetPrice: number, trailDistance?: number, client: PrismaClient = prisma): Promise<PaperSummary> {
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
      trailingStop: true,
      trailDistance: nextTrailDistance,
      bestPrice: nextBestPrice,
      targetPrice: nextTargetPrice
    }
  });

  return getPaperSummary(user, client);
}

async function refreshPendingPaperOrders(userId: string | undefined, client: PrismaClient) {
  const pendingOrders = await client.paperOrder.findMany({
    where: {
      ...(userId ? { userId } : {}),
      status: "PENDING"
    },
    orderBy: { createdAt: "asc" }
  });

  await Promise.all(
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
        return;
      }

      const filledPrice = normalizeTradablePrice(order.requestedPrice.toNumber());
      const trailDistance = normalizeTradablePrice(order.trailDistance?.toNumber() ?? Math.abs(filledPrice - order.stopLoss.toNumber()));
      const stopLoss = order.trailingStop ? getTrailingStopLoss(order.action, filledPrice, trailDistance) : normalizeTradablePrice(order.stopLoss.toNumber());
      const targetPrice = normalizeTradablePrice(order.targetPrice.toNumber());
      const now = new Date();

      await client.$transaction(async (tx) => {
        const currentOrder = await tx.paperOrder.findUnique({
          where: { id: order.id },
          select: { status: true }
        });

        if (currentOrder?.status !== "PENDING") {
          return;
        }

        await tx.paperOrder.update({
          where: { id: order.id },
          data: {
            status: "FILLED",
            filledPrice,
            stopLoss,
            trailDistance,
            targetPrice
          }
        });

        await tx.paperPosition.create({
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
            openedAt: now
          }
        });
      });
    })
  );
}

async function refreshOpenPositionPrices(userId: string | undefined, client: PrismaClient) {
  const positions = await client.paperPosition.findMany({
    where: {
      ...(userId ? { userId } : {}),
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

  await Promise.all(
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
        return;
      }

      const latestPrice = latestTick.lastPrice.toNumber();
      const currentStopLoss = position.stopLoss.toNumber();
      const targetPrice = position.targetPrice.toNumber();
      const isBuy = position.action === "BUY";
      const trailDistance = normalizeTradablePrice(position.trailDistance?.toNumber() ?? Math.abs(position.entryPrice.toNumber() - currentStopLoss));
      const currentBestPrice = position.bestPrice?.toNumber() ?? position.entryPrice.toNumber();
      const nextBestPrice = isBuy ? Math.max(currentBestPrice, latestPrice) : Math.min(currentBestPrice, latestPrice);
      const scoreSignal = position.trailingStop ? await getCachedScoreSignal(position.underlyingSymbol, position.expiryLabel) : 0;
      const nextStopLoss = position.trailingStop ? getDynamicTrailingStopLoss(position.action, position.optionType, position.entryPrice.toNumber(), latestPrice, targetPrice, nextBestPrice, trailDistance, scoreSignal) : currentStopLoss;
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
        }
      });

      if (hitStop || hitTarget) {
        const updatedPosition = await client.paperPosition.findUnique({
          where: { id: position.id }
        });

        if (updatedPosition?.status === "OPEN") {
          await closePositionRecord(updatedPosition, hitTarget ? "TARGET" : "STOP_LOSS", client);
        }
      }
    })
  );
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
) {
  const entryPrice = position.entryPrice.toNumber();
  const exitPrice = position.currentPrice.toNumber();
  const direction = position.action === "BUY" ? 1 : -1;
  const grossPnl = (exitPrice - entryPrice) * position.quantity * direction;
  const charges = Math.max(1, Math.abs(exitPrice * position.quantity) * 0.0005);
  const netPnl = grossPnl - charges;
  const now = new Date();

  await client.$transaction(async (tx) => {
    await tx.paperPosition.update({
      where: { id: position.id },
      data: {
        status: "CLOSED",
        realizedPnl: netPnl,
        closedAt: now,
        exitReason
      }
    });

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
    unrealizedPnl: (currentPrice - entryPrice) * position.quantity * direction,
    openedAt: position.openedAt.toISOString(),
    ownerEmail: position.user?.email,
    ownerName: position.user?.displayName ?? undefined
  };
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
  return (await getStoredFnoLotSize(underlyingSymbol, expiry, client)) ?? getFallbackLotSizeForUnderlying(underlyingSymbol);
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

function getFallbackLotSizeForUnderlying(underlyingSymbol: string) {
  const lotSizes: Record<string, number> = {
    NIFTY: 65,
    BANKNIFTY: 30,
    FINNIFTY: 60,
    MIDCPNIFTY: 120,
    NIFTYNXT50: 25,
    SENSEX: 20,
    BANKEX: 30,
    CRUDEOIL: 100,
    NATURALGAS: 1250,
    COPPER: 2500,
    SILVER: 30
  };
  return lotSizes[underlyingSymbol.toUpperCase()] ?? 1;
}

function lotsFromQuantity(quantity: number, lotSize: number) {
  return Math.max(1, Math.round(quantity / lotSize));
}

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
      return normalizeTradablePrice(action === "BUY" ? entryPrice + 3 : Math.max(0, entryPrice - 3));
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
  const snapshot = await client.optionChainSnapshot.findFirst({
    where: {
      underlyingSymbol,
      expiry: {
        expiryLabel
      }
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

function shouldFillPaperOrder(action: string, entryPrice: number, latestPrice: number) {
  return action === "BUY" ? latestPrice >= entryPrice : latestPrice <= entryPrice;
}

function normalizeTradablePrice(value: number, tickSize = 0.05) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Number((Math.ceil((value - 1e-9) / tickSize) * tickSize).toFixed(2));
}
