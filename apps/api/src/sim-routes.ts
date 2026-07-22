// Paper Trading Pro (seller strategy simulator) routes.
//
// Registered as a self-contained plugin so the existing /api/paper/* module
// stays completely untouched. Everything lives under /api/sim/*.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SimOrderRejectedError, closeSimTrade, computeSimStress, getSimSummary, placeSimTrade, quoteSimTrade, resetSimAccount } from "@option-decode/db";
import type { AuthUserDto } from "@option-decode/db";

const simLegSchema = z.object({
  side: z.enum(["SELL", "BUY"]),
  optionType: z.enum(["CE", "PE"]),
  strikePrice: z.coerce.number().positive()
});

const simTradeSchema = z.object({
  underlyingSymbol: z.string().trim().min(1),
  expiry: z.string().trim().min(1),
  strategyType: z.enum(["SHORT_STRADDLE", "BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "IRON_CONDOR", "NAKED_CALL", "NAKED_PUT"]),
  horizon: z.enum(["INTRADAY", "WEEKLY", "MONTHLY"]),
  lots: z.coerce.number().int().positive().max(100),
  legs: z.array(simLegSchema).min(1).max(4),
  // Phase 2: present only when the ticket was pre-filled from a Strike
  // Matrix recommendation - stored for signal-performance attribution and
  // used server-side to enforce the WCI conviction threshold.
  entryWci: z.coerce.number().optional(),
  entryDrcr: z.coerce.number().optional(),
  signalRef: z.string().trim().max(191).optional()
});

const simResetSchema = z.object({
  startingCapital: z.coerce.number().positive().max(1_000_000_000).optional()
});

type GetRequestUser = (cookieHeader: string | undefined) => Promise<AuthUserDto | null>;

export function registerSimRoutes(app: FastifyInstance, getRequestUser: GetRequestUser): void {
  app.get("/api/sim/summary", async (request, reply) => {
    const user = await getRequestUser(request.headers.cookie);
    if (!user) {
      return reply.status(401).send({ message: "Login is required." });
    }
    return getSimSummary(user);
  });

  // Phase 3: what-if grid - projected P&L and maintenance margin across
  // spot +/-2% and IV +/-20% scenarios.
  app.get("/api/sim/stress", async (request, reply) => {
    const user = await getRequestUser(request.headers.cookie);
    if (!user) {
      return reply.status(401).send({ message: "Login is required." });
    }
    return computeSimStress(user);
  });

  app.post("/api/sim/account/reset", async (request, reply) => {
    const user = await getRequestUser(request.headers.cookie);
    if (!user) {
      return reply.status(401).send({ message: "Login is required." });
    }
    const parsed = simResetSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid reset request" });
    }
    await resetSimAccount(user, parsed.data.startingCapital);
    return getSimSummary(user);
  });

  // Price a strategy without placing it: applies the liquidity filter,
  // slippage fill, BPE, POP estimate, and IV/HV edge check so the order
  // ticket can show the trader exactly what would happen.
  app.post("/api/sim/quote", async (request, reply) => {
    const user = await getRequestUser(request.headers.cookie);
    if (!user) {
      return reply.status(401).send({ message: "Login is required." });
    }
    const parsed = simTradeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: "Invalid quote request",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    return quoteSimTrade(parsed.data);
  });

  app.post("/api/sim/trades", async (request, reply) => {
    const user = await getRequestUser(request.headers.cookie);
    if (!user) {
      return reply.status(401).send({ message: "Login is required." });
    }
    const parsed = simTradeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: "Invalid sim trade",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    try {
      const { tradeId } = await placeSimTrade(parsed.data, user);
      const summary = await getSimSummary(user);
      return { tradeId, summary };
    } catch (error) {
      if (error instanceof SimOrderRejectedError) {
        return reply.status(400).send({ message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { tradeId: string } }>("/api/sim/trades/:tradeId/close", async (request, reply) => {
    const user = await getRequestUser(request.headers.cookie);
    if (!user) {
      return reply.status(401).send({ message: "Login is required." });
    }
    try {
      return await closeSimTrade(request.params.tradeId, user, "MANUAL");
    } catch (error) {
      if (error instanceof SimOrderRejectedError) {
        return reply.status(400).send({ message: error.message });
      }
      throw error;
    }
  });
}
