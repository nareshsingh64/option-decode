import type { AlertThresholdConfig, MarketAlert, OptionChainSnapshot, OptionContractTick, PressureScore, PressureZone } from "@option-decode/types";

function pressureValue(tick: OptionContractTick, averageVolume = 0): number {
  const oi = toLots(tick.openInterest, tick);
  const oiChange = toLots(tick.changeInOpenInterest, tick);
  const volume = toLots(tick.volume, tick);
  const volumeContribution = weightedVolumeContribution(volume, averageVolume);
  const ltpChange = tick.lastPriceChange ?? 0;

  if (oiChange > 0 && ltpChange < 0) {
    return oi + Math.abs(oiChange) * 1.5 + volumeContribution;
  }
  if (oiChange < 0 && ltpChange > 0) {
    return oi - Math.abs(oiChange) * 1.2 + volumeContribution * 0.5;
  }
  if (oiChange > 0 && ltpChange > 0) {
    return oi + Math.abs(oiChange) * 0.4 + volumeContribution * 0.5;
  }

  return oi + oiChange * 0.5 + volumeContribution * 0.5;
}

function topZones(ticks: OptionContractTick[], spotPrice: number, label: "support" | "resistance"): PressureZone[] {
  const directionalTicks = ticks.filter((tick) => (label === "support" ? tick.strikePrice <= spotPrice : tick.strikePrice >= spotPrice));
  const rankedTicks = directionalTicks.length ? directionalTicks : ticks;
  const averageVolume = averageLotsVolume(ticks);
  return rankedTicks
    .map((tick) => ({
      strikePrice: tick.strikePrice,
      score: Math.round(pressureValue(tick, averageVolume)),
      reason: `${tick.optionType} ${label} pressure from OI, OI change, and volume in lots`
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

export function calculatePressureScore(snapshot: OptionChainSnapshot): PressureScore {
  const peTicks = snapshot.ticks.filter((tick) => tick.optionType === "PE");
  const ceTicks = snapshot.ticks.filter((tick) => tick.optionType === "CE");
  const peAverageVolume = averageLotsVolume(peTicks);
  const ceAverageVolume = averageLotsVolume(ceTicks);
  const pePressure = peTicks.reduce((total, tick) => total + pressureValue(tick, peAverageVolume), 0);
  const cePressure = ceTicks.reduce((total, tick) => total + pressureValue(tick, ceAverageVolume), 0);
  const displayPePressure = Math.max(0, pePressure);
  const displayCePressure = Math.max(0, cePressure);
  const total = Math.max(displayPePressure + displayCePressure, 1);
  const totalPeOi = peTicks.reduce((sum, tick) => sum + toLots(tick.openInterest, tick), 0);
  const totalCeOi = ceTicks.reduce((sum, tick) => sum + toLots(tick.openInterest, tick), 0);

  return {
    bullishPressure: Math.round((displayPePressure / total) * 100),
    bearishPressure: Math.round((displayCePressure / total) * 100),
    supportZones: topZones(peTicks, snapshot.spotPrice, "support"),
    resistanceZones: topZones(ceTicks, snapshot.spotPrice, "resistance"),
    pcr: totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(2)) : undefined,
    maxPain: calculateMaxPain(snapshot.ticks)
  };
}

function calculateMaxPain(ticks: OptionContractTick[]): number | undefined {
  const strikes = [...new Set(ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  if (!strikes.length) {
    return undefined;
  }

  let bestStrike = strikes[0];
  let lowestPain = Number.POSITIVE_INFINITY;
  for (const candidate of strikes) {
    const pain = ticks.reduce((sum, tick) => {
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

function toLots(value: number | undefined, tick: OptionContractTick): number {
  const lotSize = tick.lotSize && tick.lotSize > 0 ? tick.lotSize : 1;
  return (value ?? 0) / lotSize;
}

function averageLotsVolume(ticks: OptionContractTick[]): number {
  if (!ticks.length) {
    return 0;
  }

  return ticks.reduce((sum, tick) => sum + toLots(tick.volume, tick), 0) / ticks.length;
}

function weightedVolumeContribution(volume: number, averageVolume: number): number {
  const surgeMultiplier = averageVolume > 0 && volume > averageVolume * 2 ? 1.5 : 1;
  return volume * 0.5 * surgeMultiplier;
}

export function generateMarketAlerts(snapshot: OptionChainSnapshot, pressure: PressureScore, now = new Date(), thresholds?: AlertThresholdConfig): MarketAlert[] {
  const createdAt = now.toISOString();
  const alerts: MarketAlert[] = [];
  const nearestResistance = pressure.resistanceZones[0];
  const nearestSupport = pressure.supportZones[0];
  const resistanceDistance = nearestResistance ? Math.abs(nearestResistance.strikePrice - snapshot.spotPrice) : undefined;
  const supportDistance = nearestSupport ? Math.abs(snapshot.spotPrice - nearestSupport.strikePrice) : undefined;
  const proximityThreshold = thresholds?.proximityPoints ?? getProximityThreshold(snapshot.underlyingSymbol);
  const pressureWarning = thresholds?.pressureWarning ?? 55;
  const pressureCritical = thresholds?.pressureCritical ?? 62;
  const pcrUpper = thresholds?.pcrUpper ?? 1.15;
  const pcrLower = thresholds?.pcrLower ?? 0.85;
  const pcrCriticalUpper = pcrUpper + 0.1;
  const pcrCriticalLower = Math.max(0, pcrLower - 0.1);
  const maxPainDistance = pressure.maxPain !== undefined ? Math.abs(snapshot.spotPrice - pressure.maxPain) : undefined;

  if (pressure.bearishPressure >= pressureWarning && nearestResistance) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-bearish-pressure`,
      severity: pressure.bearishPressure >= pressureCritical ? "critical" : "warning",
      title: "Resistance pressure active",
      message: `CE pressure is ${pressure.bearishPressure}% with strongest resistance near ${formatStrike(nearestResistance.strikePrice)}.`,
      metric: "bearishPressure",
      createdAt
    });
  }

  if (pressure.bullishPressure >= pressureWarning && nearestSupport) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-bullish-pressure`,
      severity: pressure.bullishPressure >= pressureCritical ? "critical" : "warning",
      title: "Support pressure active",
      message: `PE support is ${pressure.bullishPressure}% with strongest support near ${formatStrike(nearestSupport.strikePrice)}.`,
      metric: "bullishPressure",
      createdAt
    });
  }

  if (pressure.pcr !== undefined && (pressure.pcr >= pcrUpper || pressure.pcr <= pcrLower)) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-pcr-bias`,
      severity: pressure.pcr >= pcrCriticalUpper || pressure.pcr <= pcrCriticalLower ? "critical" : "warning",
      title: "PCR bias detected",
      message: `PCR is ${pressure.pcr.toFixed(2)}, showing ${pressure.pcr > 1 ? "put-side support" : "call-side resistance"} bias.`,
      metric: "pcr",
      createdAt
    });
  }

  if (resistanceDistance !== undefined && resistanceDistance <= proximityThreshold && nearestResistance) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-near-resistance`,
      severity: "info",
      title: "CMP near resistance",
      message: `Spot is within ${formatStrike(resistanceDistance)} points of resistance at ${formatStrike(nearestResistance.strikePrice)}.`,
      metric: "resistanceDistance",
      createdAt
    });
  }

  if (supportDistance !== undefined && supportDistance <= proximityThreshold && nearestSupport) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-near-support`,
      severity: "info",
      title: "CMP near support",
      message: `Spot is within ${formatStrike(supportDistance)} points of support at ${formatStrike(nearestSupport.strikePrice)}.`,
      metric: "supportDistance",
      createdAt
    });
  }

  if (maxPainDistance !== undefined && pressure.maxPain !== undefined && maxPainDistance <= proximityThreshold) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-near-max-pain`,
      severity: "info",
      title: "CMP near max pain",
      message: `Spot is within ${formatStrike(maxPainDistance)} points of max pain at ${formatStrike(pressure.maxPain)}.`,
      metric: "maxPainDistance",
      createdAt
    });
  }

  return alerts.slice(0, 7);
}

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function getProximityThreshold(underlyingSymbol: string) {
  const thresholds: Record<string, number> = {
    NIFTY: 100,
    BANKNIFTY: 250,
    FINNIFTY: 100,
    MIDCPNIFTY: 75,
    NIFTYNXT50: 150,
    SENSEX: 250,
    BANKEX: 150,
    CRUDEOIL: 30,
    NATURALGAS: 5,
    COPPER: 10,
    SILVER: 150
  };

  return thresholds[underlyingSymbol.toUpperCase()] ?? 100;
}
