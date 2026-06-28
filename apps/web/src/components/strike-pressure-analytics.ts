import type { MarketOverview, OverviewTick } from "./live-dashboard";

export type OptionActivityKind = "LONG_BUILDUP" | "WRITING" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL";

interface ChainStats {
  maxOiStrikeText: string;
  maxOiSide: string;
}

export function buildStrikeMovementRows(overview: MarketOverview) {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === overview.snapshot.atmStrike);
  if (atmIndex < 0) {
    return [];
  }

  const windowStrikes = strikes.slice(Math.max(0, atmIndex - 2), atmIndex + 3);
  const trendSamples = windowStrikes
    .flatMap((strike) => {
      const ce = findOptionTick(overview, strike, "CE");
      const pe = findOptionTick(overview, strike, "PE");
      return [Math.abs(strikeTrendScore(ce)), Math.abs(strikeTrendScore(pe))];
    })
    .filter((score) => score > 0)
    .sort((left, right) => left - right);
  const medianTrend = trendSamples.length ? trendSamples[Math.floor(trendSamples.length / 2)] ?? 8 : 8;
  const trendThreshold = Math.max(4, medianTrend);

  return windowStrikes
    .map((strike, index, windowStrikes) => {
      const ce = findOptionTick(overview, strike, "CE");
      const pe = findOptionTick(overview, strike, "PE");
      const peScore = strikePressureScore(pe);
      const ceScore = strikePressureScore(ce);
      const peActivity = classifyOptionActivity(pe);
      const ceActivity = classifyOptionActivity(ce);
      const buyerMomentumScore = getBuyerMomentumScore(ce) + getBuyerMomentumScore(pe);
      const sellerSafetyScore = getSellerSafetyScore(ce) + getSellerSafetyScore(pe);
      const combinedScore = peScore + ceScore;
      const isThinMarket = combinedScore < 10;
      const netScore = peScore - ceScore;
      const netScorePercent = isThinMarket ? 0 : Math.round((netScore / combinedScore) * 100);
      const scoreBarPercent = isThinMarket ? 0 : Math.min(100, Math.abs(netScorePercent));
      const trendScore = strikeTrendScore(pe) - strikeTrendScore(ce);
      const trendDirection = !isThinMarket && Math.abs(trendScore) >= trendThreshold ? Math.sign(trendScore) : 0;
      const absoluteIndex = strikes.indexOf(strike);
      const distance = absoluteIndex - atmIndex;
      const bias = isThinMarket ? "Balanced" : netScore > 0 ? "Up / support" : netScore < 0 ? "Down / resistance" : "Balanced";
      const trend = trendDirection > 0 ? "Increasing support" : trendDirection < 0 ? "Increasing resistance" : "Flat";

      return {
        strike,
        isAtm: strike === overview.snapshot.atmStrike,
        distanceLabel: distance === 0 ? "ATM" : distance > 0 ? `ATM +${distance}` : `ATM ${distance}`,
        peScore,
        ceScore,
        peActivity,
        ceActivity,
        buyerMomentumScore,
        sellerSafetyScore,
        netScore,
        netScorePercent,
        scoreBarPercent,
        trendScore,
        trendDirection,
        bias,
        trend,
        trendIcon: trendDirection > 0 ? "▲" : trendDirection < 0 ? "▼" : "•",
        toneClass: isThinMarket ? "text-terminal-muted" : netScore > 0 ? "text-terminal-emerald" : netScore < 0 ? "text-terminal-red" : "text-terminal-blue",
        trendToneClass: trendDirection > 0 ? "text-terminal-emerald" : trendDirection < 0 ? "text-terminal-red" : "text-terminal-blue",
        sortOrder: windowStrikes.length - index
      };
    })
    .sort((left, right) => right.strike - left.strike);
}

export function buildTradeInterpretation(rows: ReturnType<typeof buildStrikeMovementRows>) {
  const buyerScore = rows.reduce((sum, row) => sum + row.buyerMomentumScore, 0);
  const sellerScore = rows.reduce((sum, row) => sum + row.sellerSafetyScore, 0);
  return {
    buyerScore,
    sellerScore,
    buyerText: formatDirectionalScore(buyerScore, "CE buy", "PE buy"),
    sellerText: formatDirectionalScore(sellerScore, "Sell PE", "Sell CE")
  };
}

export function buildStrikeMovementSummary(rows: ReturnType<typeof buildStrikeMovementRows>) {
  if (!rows.length) {
    return {
      bias: "--",
      strongestStrike: "--",
      trend: "--"
    };
  }

  const totalScore = rows.reduce((sum, row) => sum + row.netScore, 0);
  const strongest = [...rows].sort((left, right) => Math.abs(right.netScore) - Math.abs(left.netScore))[0];
  const building = [...rows].filter((row) => row.trendDirection !== 0).sort((left, right) => Math.abs(right.trendScore) - Math.abs(left.trendScore))[0];

  return {
    bias: totalScore > 0 ? "Upside support building" : totalScore < 0 ? "Downside resistance building" : "Balanced near ATM",
    strongestStrike: strongest ? `${formatStrike(strongest.strike)} (${strongest.bias})` : "--",
    trend: building ? `${formatStrike(building.strike)} ${building.trend}` : "Flat"
  };
}

export function classifyOptionActivity(tick?: OverviewTick): OptionActivityKind {
  if (!tick) {
    return "NEUTRAL";
  }
  const oiChange = tick.changeInOpenInterest ?? 0;
  const ltpChange = tick.lastPriceChange ?? 0;
  if (oiChange > 0 && ltpChange > 0) {
    return "LONG_BUILDUP";
  }
  if (oiChange > 0 && ltpChange < 0) {
    return "WRITING";
  }
  if (oiChange < 0 && ltpChange > 0) {
    return "SHORT_COVERING";
  }
  if (oiChange < 0 && ltpChange < 0) {
    return "LONG_UNWINDING";
  }
  return "NEUTRAL";
}

export function getActivityLabel(activity: OptionActivityKind) {
  switch (activity) {
    case "LONG_BUILDUP":
      return "Long build";
    case "WRITING":
      return "Writing";
    case "SHORT_COVERING":
      return "Short cover";
    case "LONG_UNWINDING":
      return "Unwind";
    default:
      return "Neutral";
  }
}

export function getActivityToneClass(activity: OptionActivityKind) {
  switch (activity) {
    case "LONG_BUILDUP":
      return "text-terminal-blue";
    case "WRITING":
      return "text-terminal-emerald";
    case "SHORT_COVERING":
      return "text-terminal-red";
    case "LONG_UNWINDING":
      return "text-terminal-amber";
    default:
      return "text-terminal-muted";
  }
}

export function buildZoneRows(overview: MarketOverview) {
  const resistance = overview.pressure.resistanceZones.slice(0, 2).map((zone, index) => ({
    label: `R${index + 1}`,
    value: zone.strikePrice,
    status: index === 0 ? "Strong" : "Moderate",
    tone: "red" as const,
    isCurrent: false
  }));
  const support = overview.pressure.supportZones.slice(0, 2).map((zone, index) => ({
    label: `S${index + 1}`,
    value: zone.strikePrice,
    status: index === 0 ? "Strong" : "Key Level",
    tone: "green" as const,
    isCurrent: false
  }));

  return [
    ...resistance,
    {
      label: "CMP",
      value: overview.snapshot.spotPrice,
      status: "Current",
      tone: "blue" as const,
      isCurrent: true
    },
    ...support
  ];
}

export function buildPressureSummary(overview: MarketOverview) {
  const pressureGap = overview.pressure.bullishPressure - overview.pressure.bearishPressure;
  const pressureGapAbs = Math.abs(pressureGap);
  const support = overview.pressure.supportZones[0];
  const resistance = overview.pressure.resistanceZones[0];
  const supportDistance = support ? Math.abs(overview.snapshot.spotPrice - support.strikePrice) : undefined;
  const resistanceDistance = resistance ? Math.abs(resistance.strikePrice - overview.snapshot.spotPrice) : undefined;
  const bias = pressureGap >= 6 ? "Bullish" : pressureGap <= -6 ? "Bearish" : "Balanced";
  const pcr = overview.pressure.pcr;
  const pcrTone = pcr === undefined ? "blue" : pcr >= 1.05 ? "green" : pcr <= 0.95 ? "red" : "blue";
  const pcrAligned = (bias === "Bullish" && pcr !== undefined && pcr >= 1.05) || (bias === "Bearish" && pcr !== undefined && pcr <= 0.95);
  const maxPainStrike = overview.pressure.maxPain ?? calculateMaxPainStrike(overview);
  const maxPainDistance = maxPainStrike === undefined ? undefined : maxPainStrike - overview.snapshot.spotPrice;
  const currentActivityScore = calculateCurrentActivityScore(overview);
  const convictionScore = Math.min(100, Math.round(pressureGapAbs * 3 + currentActivityScore));
  const conviction = convictionScore >= 70 ? "High" : convictionScore >= 45 ? "Medium" : "Low";
  const convictionTone = conviction === "High" ? "green" : conviction === "Medium" ? "blue" : "red";
  const setupQuality = Math.min(100, Math.round(pressureGapAbs * 4 + (pcrAligned ? 18 : 0) + (convictionScore * 0.45) + getLevelProximityScore(supportDistance, resistanceDistance)));
  const setupQualityGrade = setupQuality >= 80 ? "A+" : setupQuality >= 70 ? "A" : setupQuality >= 55 ? "B" : setupQuality >= 40 ? "C" : "Wait";
  const setupQualityTone = setupQuality >= 70 ? "green" : setupQuality >= 40 ? "blue" : "red";
  const readiness = setupQuality >= 70 && convictionScore >= 45 && pressureGapAbs >= 6 ? "Actionable" : setupQuality >= 45 || pressureGapAbs >= 4 ? "Watch" : "Wait";
  const strongestSupport = support?.score ?? 0;
  const strongestResistance = resistance?.score ?? 0;
  const strongestLevelText =
    strongestSupport >= strongestResistance && support
      ? `${formatStrike(support.strikePrice)} PE`
      : resistance
        ? `${formatStrike(resistance.strikePrice)} CE`
        : "--";

  return {
    bias,
    biasDetail: `${pressureGapAbs} pt pressure spread`,
    readiness,
    readinessDetail: readiness === "Actionable" ? `Quality ${setupQuality}% with confirmed pressure` : readiness === "Watch" ? `Quality ${setupQuality}% but needs follow-through` : `Quality ${setupQuality}% / no clean edge`,
    pcrText: pcr?.toFixed(2) ?? "--",
    pcrDetail: pcr === undefined ? "PCR unavailable" : pcrAligned ? "PCR confirms bias" : pcr >= 1.05 ? "Put support heavy" : pcr <= 0.95 ? "Call pressure heavy" : "Balanced PCR",
    pcrTone: pcrTone as "blue" | "green" | "red",
    maxPainText: maxPainStrike === undefined ? "--" : formatStrike(maxPainStrike),
    maxPainDistanceText: formatMaxPainDistance(maxPainDistance),
    conviction,
    convictionScore,
    convictionDetail: currentActivityScore >= 35 ? "active tape" : currentActivityScore >= 18 ? "moderate tape" : "thin tape",
    convictionTone: convictionTone as "blue" | "green" | "red",
    setupQualityText: `${setupQualityGrade} / ${setupQuality}%`,
    setupQualityDetail: pcrAligned ? "PCR and pressure aligned" : bias === "Balanced" ? "Waiting for direction" : "Pressure needs PCR support",
    setupQualityTone: setupQualityTone as "blue" | "green" | "red",
    nearestSupportText: support ? formatStrike(support.strikePrice) : "--",
    nearestResistanceText: resistance ? formatStrike(resistance.strikePrice) : "--",
    supportDistanceText: supportDistance === undefined ? "No support zone" : `${formatStrike(supportDistance)} pts below/near`,
    resistanceDistanceText: resistanceDistance === undefined ? "No resistance zone" : `${formatStrike(resistanceDistance)} pts above/near`,
    strongestLevelText
  };
}

export function buildPressureSignals(overview: MarketOverview, chainStats: ChainStats) {
  const summary = buildPressureSummary(overview);
  return [
    {
      label: "Direction",
      value: summary.bias,
      detail: summary.biasDetail,
      tone: summary.bias === "Bullish" ? "green" as const : summary.bias === "Bearish" ? "red" as const : "blue" as const
    },
    {
      label: "Strike Magnet",
      value: chainStats.maxOiStrikeText,
      detail: chainStats.maxOiSide,
      tone: "blue" as const
    },
    {
      label: "Support Gap",
      value: summary.nearestSupportText,
      detail: summary.supportDistanceText,
      tone: "green" as const
    },
    {
      label: "Resistance Gap",
      value: summary.nearestResistanceText,
      detail: summary.resistanceDistanceText,
      tone: "red" as const
    }
  ];
}

export function scoreToPercent(score: number) {
  return Math.max(5, Math.min(100, Math.round(score / 15000)));
}

function findOptionTick(overview: MarketOverview, strikePrice: number, optionType: "CE" | "PE") {
  return overview.snapshot.ticks.find((tick) => tick.strikePrice === strikePrice && tick.optionType === optionType);
}

function formatDirectionalScore(score: number, positiveLabel: string, negativeLabel: string) {
  if (Math.abs(score) < 8) {
    return "Neutral";
  }
  return `${score > 0 ? positiveLabel : negativeLabel} ${formatSignedLarge(score)}`;
}

function strikePressureScore(tick?: OverviewTick) {
  if (!tick) {
    return 0;
  }
  const score = toLots(tick.openInterest, tick) + toLots(tick.changeInOpenInterest, tick) * 1.5 + toLots(tick.volume, tick) * 0.5;
  return Math.max(0, Math.round(score));
}

function strikeTrendScore(tick?: OverviewTick) {
  if (!tick) {
    return 0;
  }
  const oiTrend = toLots(tick.changeInOpenInterest, tick);
  const ltpTrend = (tick.lastPriceChangePercent ?? 0) * 2;
  return Math.round(oiTrend + ltpTrend);
}

function optionActivityWeight(tick?: OverviewTick) {
  if (!tick) {
    return 0;
  }
  return Math.round(Math.abs(toLots(tick.changeInOpenInterest, tick)) + Math.abs(toLots(tick.volume, tick)) * 0.05 + Math.abs(tick.lastPriceChangePercent ?? 0) * 2);
}

function getBuyerMomentumScore(tick?: OverviewTick) {
  const activity = classifyOptionActivity(tick);
  const weight = optionActivityWeight(tick);
  if (!tick || !weight) {
    return 0;
  }
  const direction = tick.optionType === "CE" ? 1 : -1;
  if (activity === "LONG_BUILDUP") {
    return direction * weight;
  }
  if (activity === "SHORT_COVERING") {
    return direction * Math.round(weight * 0.5);
  }
  if (activity === "WRITING") {
    return -direction * Math.round(weight * 0.6);
  }
  return 0;
}

function getSellerSafetyScore(tick?: OverviewTick) {
  const activity = classifyOptionActivity(tick);
  const weight = optionActivityWeight(tick);
  if (!tick || !weight) {
    return 0;
  }
  const supportDirection = tick.optionType === "PE" ? 1 : -1;
  if (activity === "WRITING") {
    return supportDirection * weight;
  }
  if (activity === "SHORT_COVERING") {
    return -supportDirection * weight;
  }
  if (activity === "LONG_BUILDUP") {
    return -supportDirection * Math.round(weight * 0.5);
  }
  return 0;
}

function calculateMaxPainStrike(overview: MarketOverview) {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  if (!strikes.length) {
    return undefined;
  }

  let bestStrike = strikes[0];
  let lowestPain = Number.POSITIVE_INFINITY;
  for (const candidate of strikes) {
    const pain = overview.snapshot.ticks.reduce((sum, tick) => {
      const openInterestLots = toLots(tick.openInterest, tick);
      const intrinsic = tick.optionType === "CE" ? Math.max(0, candidate - tick.strikePrice) : Math.max(0, tick.strikePrice - candidate);
      return sum + openInterestLots * intrinsic;
    }, 0);
    if (pain < lowestPain) {
      lowestPain = pain;
      bestStrike = candidate;
    }
  }

  return bestStrike;
}

function calculateCurrentActivityScore(overview: MarketOverview) {
  const totalOiLots = overview.snapshot.ticks.reduce((sum, tick) => sum + toLots(tick.openInterest, tick), 0);
  if (totalOiLots <= 0) {
    return 0;
  }
  const totalChangeLots = overview.snapshot.ticks.reduce((sum, tick) => sum + Math.abs(toLots(tick.changeInOpenInterest, tick)), 0);
  const totalVolumeLots = overview.snapshot.ticks.reduce((sum, tick) => sum + toLots(tick.volume, tick), 0);
  const activityRatio = (totalChangeLots + totalVolumeLots * 0.25) / totalOiLots;
  return Math.min(55, Math.round(activityRatio * 100));
}

function getLevelProximityScore(supportDistance?: number, resistanceDistance?: number) {
  const nearestDistance = Math.min(supportDistance ?? Number.POSITIVE_INFINITY, resistanceDistance ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(nearestDistance)) {
    return 0;
  }
  if (nearestDistance <= 25) {
    return 14;
  }
  if (nearestDistance <= 75) {
    return 10;
  }
  if (nearestDistance <= 150) {
    return 6;
  }
  return 2;
}

function formatMaxPainDistance(distance?: number) {
  if (distance === undefined) {
    return "Distance unavailable";
  }
  if (Math.abs(distance) < 0.01) {
    return "At spot";
  }
  return `${formatPrice(Math.abs(distance))} pts ${distance > 0 ? "above spot" : "below spot"}`;
}

function formatPrice(value?: number) {
  return value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function formatSignedLarge(value?: number) {
  if (value === undefined) {
    return "--";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatLarge(value)}`;
}

function formatLarge(value?: number) {
  if (value === undefined) {
    return "--";
  }
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 10000000) {
    return `${(value / 10000000).toFixed(1)}Cr`;
  }
  if (absoluteValue >= 100000) {
    return `${(value / 100000).toFixed(1)}L`;
  }
  if (absoluteValue >= 1000) {
    return `${(value / 1000).toFixed(0)}K`;
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function toLots(value: number | undefined, tick?: Pick<OverviewTick, "lotSize" | "underlyingSymbol">) {
  const lotSize = tick?.lotSize && tick.lotSize > 0 ? tick.lotSize : getLotSizeForUnderlying(tick?.underlyingSymbol);
  return (value ?? 0) / lotSize;
}

function getLotSizeForUnderlying(underlyingSymbol?: string) {
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
  return lotSizes[String(underlyingSymbol ?? "").toUpperCase()] ?? 1;
}
