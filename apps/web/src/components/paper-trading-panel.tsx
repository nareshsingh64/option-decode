import { useState } from "react";
import type { ReactNode } from "react";
import { CalendarDatePicker } from "./calendar-date-picker";

interface PaperTradingPanelProps {
  paperSummary: any;
  formatCurrency: any;
  formatPrice: any;
  orderEntryPrice: any;
  orderAction: any;
  marketEntryPrice: any;
  riskReward: any;
  estimatedRisk: any;
  orderTargetValue: any;
  estimatedReward: any;
  handlePaperOrder: any;
  overview: any;
  orderExpiry: any;
  setOrderExpiry: any;
  orderExpiryChoices: any;
  isLoadingOrderExpiry: any;
  orderExpiryError: any;
  setOrderAction: any;
  setIsOrderStopLossEdited: any;
  setIsOrderTargetEdited: any;
  orderOptionType: any;
  setOrderOptionType: any;
  orderStrike: any;
  setOrderStrike: any;
  strikeChoices: any;
  formatStrike: any;
  orderTick: any;
  formatLtpChange: any;
  orderEntry: any;
  setOrderEntry: any;
  formatTradablePrice: any;
  orderStopLoss: any;
  setOrderStopLoss: any;
  orderTrailingStop: any;
  setOrderTrailingStop: any;
  orderTrailDistanceValue: any;
  orderTarget: any;
  setOrderTarget: any;
  orderLots: any;
  setOrderLots: any;
  formatLotsAndQty: any;
  orderLotSize: any;
  orderQuantity: any;
  isPlacingOrder: any;
  paperError: any;
  pendingPaperOrders: any;
  pendingOrderDrafts: any;
  setPendingOrderDrafts: any;
  normalizeTradablePrice: any;
  getTrailingStopLoss: any;
  getDefaultTrailDistanceForEntry: any;
  getDefaultTargetPrice: any;
  formatIstShortDateTime: any;
  updatingPendingOrderId: any;
  cancelingPendingOrderId: any;
  handleUpdatePendingOrder: any;
  handleCancelPendingOrder: any;
  positionRiskDrafts: any;
  setPositionRiskDrafts: any;
  updatingRiskPositionId: any;
  closingPositionId: any;
  handleUpdatePositionRisk: any;
  handleClosePosition: any;
  recentPaperOrders: any;
}

type PaperTab = "open" | "pending" | "closed" | "summary";

export function PaperTradingPanel(props: PaperTradingPanelProps) {
  const {
    paperSummary,
    formatCurrency,
    formatPrice,
    orderEntryPrice,
    orderAction,
    marketEntryPrice,
    riskReward,
    estimatedRisk,
    orderTargetValue,
    estimatedReward,
    handlePaperOrder,
    overview,
    orderExpiry,
    setOrderExpiry,
    orderExpiryChoices,
    isLoadingOrderExpiry,
    orderExpiryError,
    setOrderAction,
    setIsOrderStopLossEdited,
    setIsOrderTargetEdited,
    orderOptionType,
    setOrderOptionType,
    orderStrike,
    setOrderStrike,
    strikeChoices,
    formatStrike,
    orderTick,
    formatLtpChange,
    orderEntry,
    setOrderEntry,
    formatTradablePrice,
    orderStopLoss,
    setOrderStopLoss,
    orderTrailingStop,
    setOrderTrailingStop,
    orderTrailDistanceValue,
    orderTarget,
    setOrderTarget,
    orderLots,
    setOrderLots,
    formatLotsAndQty,
    orderLotSize,
    orderQuantity,
    isPlacingOrder,
    paperError,
    pendingPaperOrders,
    pendingOrderDrafts,
    setPendingOrderDrafts,
    normalizeTradablePrice,
    getTrailingStopLoss,
    getDefaultTrailDistanceForEntry,
    getDefaultTargetPrice,
    formatIstShortDateTime,
    updatingPendingOrderId,
    cancelingPendingOrderId,
    handleUpdatePendingOrder,
    handleCancelPendingOrder,
    positionRiskDrafts,
    setPositionRiskDrafts,
    updatingRiskPositionId,
    closingPositionId,
    handleUpdatePositionRisk,
    handleClosePosition,
    recentPaperOrders
  } = props;
  const [activeTab, setActiveTab] = useState<PaperTab>("open");
  const totalOpenDeltaExposure = (paperSummary?.openPositions ?? []).reduce((total: number, position: any) => total + (position.deltaExposure ?? 0), 0);
  const openCount = paperSummary?.stats.openPositions ?? 0;
  const pendingCount = paperSummary?.stats.pendingOrders ?? 0;
  const closedCount = paperSummary?.closedTrades?.length ?? 0;

  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">Paper Trading</h2>
      <div className="mt-4 grid gap-3">
        <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-terminal-line bg-white/[0.03] px-3 py-2">
          <KpiChip label="Open" value={String(openCount)} tone="blue" />
          <KpiChip label="Pending" value={String(pendingCount)} tone="amber" />
          <KpiChip label="Realized P/L" value={formatCurrency(paperSummary?.stats.realizedPnl ?? 0)} tone={(paperSummary?.stats.realizedPnl ?? 0) >= 0 ? "emerald" : "red"} />
          <KpiChip label="MTM P/L" value={formatCurrency(paperSummary?.stats.markToMarketPnl ?? 0)} tone={(paperSummary?.stats.markToMarketPnl ?? 0) >= 0 ? "emerald" : "red"} />
          <KpiChip label="Net Delta" value={formatDeltaExposure(totalOpenDeltaExposure)} tone={deltaTone(totalOpenDeltaExposure)} />
          <KpiChip label="Filled" value={String(paperSummary?.stats.filledOrders ?? 0)} />
        </section>

        <form className="rounded border border-terminal-line bg-white/[0.03]" onSubmit={handlePaperOrder}>
          <PaperSectionHeader title="Paper Order Ticket" meta={`${overview.snapshot.underlyingSymbol} ${orderExpiry}`} />
          {/* Grid instead of a table: this only ever holds one row of inputs
              (it's an order-entry form, not a data list), so a fixed-width
              table with a wide min-width just forced horizontal scrolling
              once the Expiry column was added - especially since the
              calendar picker needs real width. A responsive grid reflows
              fields onto more rows on narrower viewports instead, so
              there's nothing to scroll regardless of window size. */}
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            <TicketField label="Symbol">
              <div className="flex h-9 items-center font-semibold">{overview.snapshot.underlyingSymbol}</div>
            </TicketField>
            <TicketField label="Expiry">
              <CalendarDatePicker
                availableDates={orderExpiryChoices}
                value={orderExpiry}
                onChange={setOrderExpiry}
                placeholder="Select expiry"
                emptyLabel="No stored expiries available yet."
              />
              {orderExpiry !== overview.selectedExpiry ? (
                <div className="mt-1 text-[0.65rem] uppercase text-terminal-blue">Next-expiry trade</div>
              ) : null}
            </TicketField>
            <TicketField label="Order">
              <select value={orderAction} onChange={(event) => {
                setOrderAction(event.target.value as "BUY" | "SELL");
                setIsOrderStopLossEdited(false);
                setIsOrderTargetEdited(false);
              }} className="h-9 w-full rounded border border-terminal-line bg-terminal-input px-2 text-sm font-semibold text-terminal-text outline-none focus:border-terminal-blue">
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </TicketField>
            <TicketField label="Type">
              <select value={orderOptionType} onChange={(event) => setOrderOptionType(event.target.value as "CE" | "PE")} className="h-9 w-full rounded border border-terminal-line bg-terminal-input px-2 text-sm text-terminal-text outline-none focus:border-terminal-blue">
                <option value="CE">CE</option>
                <option value="PE">PE</option>
              </select>
            </TicketField>
            <TicketField label="Strike">
              <select value={orderStrike} onChange={(event) => setOrderStrike(event.target.value)} className="h-9 w-full rounded border border-terminal-line bg-terminal-input px-2 text-sm text-terminal-text outline-none focus:border-terminal-blue">
                {strikeChoices.map((strike: any) => (
                  <option key={strike} value={strike}>{formatStrike(strike)}</option>
                ))}
              </select>
            </TicketField>
            <TicketField label="LTP" align="right">
              {isLoadingOrderExpiry ? (
                <div className="text-xs text-terminal-muted">Loading...</div>
              ) : (
                <>
                  <div className="font-semibold text-terminal-text">{orderTick?.lastPrice !== undefined ? formatPrice(orderTick.lastPrice) : "--"}</div>
                  <div className={`text-xs ${orderTick?.lastPriceChange === undefined ? "text-terminal-muted" : orderTick.lastPriceChange >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>{formatLtpChange(orderTick?.lastPriceChange, orderTick?.lastPriceChangePercent)}</div>
                </>
              )}
            </TicketField>
            <TicketField label="Entry" align="right">
              <input value={orderEntry} onBlur={() => setOrderEntry((value: string) => (value ? formatTradablePrice(Number(value)) : value))} onChange={(event) => setOrderEntry(event.target.value)} className="h-9 w-full rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-text outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
            </TicketField>
            <TicketField label="SL" align="right">
              <input value={orderStopLoss} onChange={(event) => {
                setIsOrderStopLossEdited(true);
                setOrderStopLoss(event.target.value);
              }} onBlur={() => setOrderStopLoss((value: string) => (value ? formatTradablePrice(Number(value)) : value))} className="h-9 w-full rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-red outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
              <label className="mt-1 flex items-center justify-end gap-1.5 text-xs text-terminal-muted">
                <input checked={orderTrailingStop} onChange={(event) => setOrderTrailingStop(event.target.checked)} type="checkbox" className="h-3.5 w-3.5 accent-terminal-blue" />
                Trailing {orderTrailingStop ? formatPrice(orderTrailDistanceValue) : ""}
              </label>
            </TicketField>
            <TicketField label="Target" align="right">
              <input value={orderTarget} onChange={(event) => {
                setIsOrderTargetEdited(true);
                setOrderTarget(event.target.value);
              }} onBlur={() => setOrderTarget((value: string) => (value ? formatTradablePrice(Number(value)) : value))} className="h-9 w-full rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-emerald outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
            </TicketField>
            <TicketField label="Lots" align="right">
              <input value={orderLots} onChange={(event) => setOrderLots(event.target.value)} className="h-9 w-full rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm text-terminal-text outline-none focus:border-terminal-blue" min="1" step="1" type="number" />
            </TicketField>
            <TicketField label="Qty" align="right">
              <div className="flex h-9 items-center justify-end text-terminal-muted">{formatLotsAndQty(Number(orderLots || 0), orderLotSize, orderQuantity)}</div>
            </TicketField>
            <TicketField label="Risk" align="right">
              <div className="flex h-9 items-center justify-end text-terminal-red">{formatCurrency(estimatedRisk)}</div>
            </TicketField>
            <TicketField label="Reward" align="right">
              <div className="flex h-9 items-center justify-end text-terminal-emerald">{formatCurrency(estimatedReward)}</div>
            </TicketField>
          </div>
          <div className="flex flex-wrap items-center gap-4 border-t border-terminal-line px-3 py-2 text-xs text-terminal-muted">
            <span>Entry Trigger: <span className="font-semibold text-terminal-text">{formatPrice(orderEntryPrice)}</span> ({orderAction === "BUY" ? "fills when LTP <= entry" : "fills when LTP >= entry"}, LTP {formatPrice(marketEntryPrice)})</span>
            <span>Risk/Reward: <span className="font-semibold text-terminal-text">{riskReward ? `1:${riskReward.toFixed(1)}` : "--"}</span></span>
            <button className={`ml-auto h-9 min-w-36 rounded border px-3 text-sm font-semibold transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${orderAction === "BUY" ? "border-terminal-emerald bg-terminal-emerald text-terminal-bg" : "border-terminal-red bg-terminal-red text-white"}`} disabled={isPlacingOrder || orderEntryPrice <= 0} type="submit">
              {isPlacingOrder ? "Placing..." : `${orderAction === "BUY" ? "Buy" : "Sell"} Trigger`}
            </button>
          </div>
          {orderExpiryError ? <p className="border-t border-terminal-line px-3 py-2 text-xs text-terminal-red">Expiry chain: {orderExpiryError}</p> : null}
          {paperError ? <p className="border-t border-terminal-line px-3 py-2 text-xs text-terminal-red">{paperError}</p> : null}
        </form>

        <div className="flex flex-wrap gap-2">
          <TabButton label="Open Positions" count={openCount} active={activeTab === "open"} onClick={() => setActiveTab("open")} />
          <TabButton label="Pending Orders" count={pendingCount} active={activeTab === "pending"} onClick={() => setActiveTab("pending")} />
          <TabButton label="Closed Trades" count={closedCount} active={activeTab === "closed"} onClick={() => setActiveTab("closed")} />
          <TabButton label="Summary" active={activeTab === "summary"} onClick={() => setActiveTab("summary")} />
        </div>

        {activeTab === "open" ? (
          <div className="grid gap-3">
            <div className="rounded border border-terminal-line bg-white/[0.03]">
              <PaperSectionHeader title="Open Position Totals" meta={`Net Delta ${formatDeltaExposure(totalOpenDeltaExposure)}`} />
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                    <tr>
                      <th className="px-3 py-3 text-left">Underlying</th>
                      <th className="px-3 py-3 text-left">Expiry</th>
                      <th className="px-3 py-3 text-right">Positions</th>
                      <th className="px-3 py-3 text-right">Contracts</th>
                      <th className="px-3 py-3 text-right">Qty</th>
                      <th className="px-3 py-3 text-right">Net Delta</th>
                      <th className="px-3 py-3 text-right">MTM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(paperSummary?.openPositionGroups ?? []).map((group: any) => (
                      <tr key={`${group.underlyingSymbol}-${group.expiry}`} className="border-t border-terminal-line/80">
                        <td className="px-3 py-3 font-semibold">{group.underlyingSymbol}</td>
                        <td className="px-3 py-3 text-terminal-muted">{group.expiry}</td>
                        <td className="px-3 py-3 text-right">{group.positions}</td>
                        <td className="px-3 py-3 text-right">{group.lots}</td>
                        <td className="px-3 py-3 text-right text-terminal-muted">{group.quantity.toLocaleString("en-IN")}</td>
                        <td className={`px-3 py-3 text-right font-semibold ${deltaToneClass(group.deltaExposure)}`}>{formatDeltaExposure(group.deltaExposure)}</td>
                        <td className={`px-3 py-3 text-right font-semibold ${group.markToMarketPnl >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>{formatCurrency(group.markToMarketPnl)}</td>
                      </tr>
                    ))}
                    {paperSummary && !paperSummary.openPositionGroups?.length ? (
                      <tr><td colSpan={7} className="px-3 py-6 text-center text-terminal-muted">No open position totals yet.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded border border-terminal-line bg-white/[0.03]">
              <PaperSectionHeader title="Open Paper Positions" meta={`${formatCurrency(paperSummary?.stats.markToMarketPnl ?? 0)} MTM`} />
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                    <tr>
                      <th className="px-3 py-3 text-left">Trade</th>
                      <th className="px-3 py-3 text-right">Qty</th>
                      <th className="px-3 py-3 text-right">Entry</th>
                      <th className="px-3 py-3 text-right">LTP</th>
                      <th className="px-3 py-3 text-right">Delta</th>
                      <th className="px-3 py-3 text-right">Trail SL</th>
                      <th className="px-3 py-3 text-right">Target</th>
                      <th className="px-3 py-3 text-right">P/L</th>
                      <th className="px-3 py-3 text-right">Opened</th>
                      <th className="px-3 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(paperSummary?.openPositions ?? []).map((position: any) => {
                      const draft = positionRiskDrafts[position.id] ?? {
                        stopLoss: formatTradablePrice(position.stopLoss),
                        trailDistance: formatTradablePrice(position.trailDistance),
                        targetPrice: formatTradablePrice(position.targetPrice),
                        trailingStop: position.trailingStop
                      };
                      const isTrailing = draft.trailingStop ?? position.trailingStop;

                      return (
                        <tr key={position.id} className="border-t border-terminal-line/80">
                          <td className="px-3 py-3">
                            <div className="font-semibold">{position.underlyingSymbol} {formatStrike(position.strikePrice)} {position.optionType}</div>
                            <div className="text-xs text-terminal-muted">{position.expiry} / {position.action}</div>
                            {position.ownerEmail ? <div className="text-xs text-terminal-blue">{position.ownerName ?? position.ownerEmail}</div> : null}
                          </td>
                          <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(position.lots, position.lotSize, position.quantity)}</td>
                          <td className="px-3 py-3 text-right">{formatPrice(position.entryPrice)}</td>
                          <td className="px-3 py-3 text-right">
                            {formatPrice(position.currentPrice)}
                            <div className="text-xs text-terminal-muted">Best {formatPrice(position.bestPrice)}</div>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <div className="font-semibold text-terminal-text">{formatDelta(position.delta)}</div>
                            <div className={`text-xs ${deltaToneClass(position.deltaExposure)}`}>{formatDeltaExposure(position.deltaExposure)}</div>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <div className="mb-1 flex items-center justify-end gap-1.5">
                              <span className={`rounded border px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase ${isTrailing ? "border-terminal-blue/60 text-terminal-blue" : "border-terminal-line text-terminal-muted"}`}>{isTrailing ? "Trailing" : "Fixed"}</span>
                              <label className="flex items-center gap-1 text-xs text-terminal-muted">
                                <input checked={isTrailing} onChange={(event) => {
                                  const nextTrailingStop = event.target.checked;
                                  setPositionRiskDrafts((drafts: any) => {
                                    const nextStopLoss = nextTrailingStop ? formatTradablePrice(getTrailingStopLoss(position.action, position.bestPrice, Number(draft.trailDistance || 0))) : draft.stopLoss;
                                    return { ...drafts, [position.id]: { ...draft, trailingStop: nextTrailingStop, stopLoss: nextStopLoss } };
                                  });
                                }} type="checkbox" className="h-3.5 w-3.5 accent-terminal-blue" />
                              </label>
                            </div>
                            {isTrailing ? (
                              <>
                                <input value={draft.trailDistance} onBlur={() => setPositionRiskDrafts((drafts: any) => ({ ...drafts, [position.id]: { ...draft, trailDistance: draft.trailDistance ? formatTradablePrice(Number(draft.trailDistance)) : draft.trailDistance } }))} onChange={(event) => setPositionRiskDrafts((drafts: any) => {
                                  const nextTrailDistance = event.target.value;
                                  const nextStopLoss = nextTrailDistance ? formatTradablePrice(getTrailingStopLoss(position.action, position.bestPrice, Number(nextTrailDistance))) : draft.stopLoss;
                                  return { ...drafts, [position.id]: { ...draft, trailDistance: nextTrailDistance, stopLoss: nextStopLoss } };
                                })} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-red outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                                <div className="mt-1 text-xs text-terminal-muted">SL {draft.stopLoss}</div>
                              </>
                            ) : (
                              <input value={draft.stopLoss} onBlur={() => setPositionRiskDrafts((drafts: any) => ({ ...drafts, [position.id]: { ...draft, stopLoss: draft.stopLoss ? formatTradablePrice(Number(draft.stopLoss)) : draft.stopLoss } }))} onChange={(event) => setPositionRiskDrafts((drafts: any) => ({ ...drafts, [position.id]: { ...draft, stopLoss: event.target.value } }))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-red outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                            )}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <input value={draft.targetPrice} onBlur={() => setPositionRiskDrafts((drafts: any) => ({ ...drafts, [position.id]: { ...draft, targetPrice: draft.targetPrice ? formatTradablePrice(Number(draft.targetPrice)) : draft.targetPrice } }))} onChange={(event) => setPositionRiskDrafts((drafts: any) => ({ ...drafts, [position.id]: { ...draft, targetPrice: event.target.value } }))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-emerald outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                          </td>
                          <td className={`px-3 py-3 text-right font-semibold ${position.unrealizedPnl >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>{formatCurrency(position.unrealizedPnl)}</td>
                          <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(position.openedAt)}</td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-2">
                              <button className="h-9 rounded border border-terminal-blue/70 bg-terminal-blue/10 px-3 text-xs font-semibold text-terminal-blue transition hover:bg-terminal-blue hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={updatingRiskPositionId === position.id} type="button" onClick={() => handleUpdatePositionRisk(position.id)}>
                                {updatingRiskPositionId === position.id ? "Saving" : "Save"}
                              </button>
                              <button className="h-9 rounded border border-terminal-red/70 bg-terminal-red/10 px-3 text-xs font-semibold text-terminal-red transition hover:bg-terminal-red hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={closingPositionId === position.id} type="button" onClick={() => handleClosePosition(position.id)}>
                                {closingPositionId === position.id ? "Exiting" : "Exit"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {paperSummary && !paperSummary.openPositions.length ? (
                      <tr><td colSpan={10} className="px-3 py-6 text-center text-terminal-muted">No open paper positions.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "pending" ? (
          <div className="rounded border border-terminal-line bg-white/[0.03]">
            <PaperSectionHeader title="Pending Orders" meta={`${pendingPaperOrders.length} waiting`} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                  <tr>
                    <th className="px-3 py-3 text-left">Order</th>
                    <th className="px-3 py-3 text-right">Contracts</th>
                    <th className="px-3 py-3 text-right">Qty</th>
                    <th className="px-3 py-3 text-right">Entry</th>
                    <th className="px-3 py-3 text-right">Current LTP</th>
                    <th className="px-3 py-3 text-right">Trigger</th>
                    <th className="px-3 py-3 text-right">SL</th>
                    <th className="px-3 py-3 text-right">Target</th>
                    <th className="px-3 py-3 text-right">Placed</th>
                    <th className="px-3 py-3 text-right">Status</th>
                    <th className="px-3 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingPaperOrders.map((order: any) => {
                    const draft = pendingOrderDrafts[order.id] ?? {
                      lots: String(order.lots),
                      requestedPrice: formatTradablePrice(order.requestedPrice),
                      stopLoss: formatTradablePrice(order.stopLoss),
                      targetPrice: formatTradablePrice(order.targetPrice),
                      trailingStop: order.trailingStop
                    };
                    const isTrailing = draft.trailingStop ?? order.trailingStop;
                    const draftLots = Math.max(1, Math.floor(Number(draft.lots || order.lots)));
                    const draftEntry = normalizeTradablePrice(Number(draft.requestedPrice || order.requestedPrice));
                    const draftStopLoss = normalizeTradablePrice(Number(draft.stopLoss || order.stopLoss));
                    const draftTrailDistance = normalizeTradablePrice(Math.abs(draftEntry - draftStopLoss));
                    const draftTargetPrice = normalizeTradablePrice(Number(draft.targetPrice || order.targetPrice));
                    const draftQuantity = draftLots * order.lotSize;
                    const currentPrice = order.currentPrice;
                    const willFill = currentPrice !== undefined ? (order.action === "BUY" ? currentPrice <= draftEntry : currentPrice >= draftEntry) : false;

                    return (
                      <tr key={order.id} className="border-t border-terminal-line/80">
                        <td className="px-3 py-3">
                          <div className="font-semibold">{order.underlyingSymbol} {formatStrike(order.strikePrice)} {order.optionType}</div>
                          <div className="text-xs text-terminal-muted">{order.expiry} / {order.action}</div>
                          {order.ownerEmail ? <div className="text-xs text-terminal-blue">{order.ownerName ?? order.ownerEmail}</div> : null}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <input value={draft.lots} onChange={(event) => setPendingOrderDrafts((drafts: any) => ({ ...drafts, [order.id]: { ...draft, lots: event.target.value } }))} className="h-9 w-20 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm text-terminal-text outline-none focus:border-terminal-blue" min="1" step="1" type="number" />
                        </td>
                        <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(draftLots, order.lotSize, draftQuantity)}</td>
                        <td className="px-3 py-3 text-right">
                          <input value={draft.requestedPrice} onBlur={() => setPendingOrderDrafts((drafts: any) => {
                            const currentDraft = drafts[order.id] ?? draft;
                            const nextEntry = normalizeTradablePrice(Number(currentDraft.requestedPrice || order.requestedPrice));
                            return {
                              ...drafts,
                              [order.id]: {
                                ...currentDraft,
                                requestedPrice: currentDraft.requestedPrice ? formatTradablePrice(Number(currentDraft.requestedPrice)) : currentDraft.requestedPrice,
                                stopLoss: nextEntry > 0 ? formatTradablePrice(getTrailingStopLoss(order.action, nextEntry, getDefaultTrailDistanceForEntry(nextEntry))) : currentDraft.stopLoss,
                                targetPrice: nextEntry > 0 ? formatTradablePrice(getDefaultTargetPrice(order.action, nextEntry)) : currentDraft.targetPrice
                              }
                            };
                          })} onChange={(event) => setPendingOrderDrafts((drafts: any) => {
                            const nextEntryText = event.target.value;
                            const nextEntry = normalizeTradablePrice(Number(nextEntryText));
                            return {
                              ...drafts,
                              [order.id]: {
                                ...draft,
                                requestedPrice: nextEntryText,
                                stopLoss: nextEntry > 0 ? formatTradablePrice(getTrailingStopLoss(order.action, nextEntry, getDefaultTrailDistanceForEntry(nextEntry))) : draft.stopLoss,
                                targetPrice: nextEntry > 0 ? formatTradablePrice(getDefaultTargetPrice(order.action, nextEntry)) : draft.targetPrice
                              }
                            };
                          })} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-text outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                        </td>
                        <td className={`px-3 py-3 text-right font-semibold ${willFill ? "text-terminal-emerald" : "text-terminal-blue"}`}>{formatPrice(currentPrice)}</td>
                        <td className="px-3 py-3 text-right text-xs text-terminal-muted">{order.action === "BUY" ? "LTP <= Entry" : "LTP >= Entry"}</td>
                        <td className="px-3 py-3 text-right">
                          <input value={draft.stopLoss} onBlur={() => setPendingOrderDrafts((drafts: any) => ({ ...drafts, [order.id]: { ...draft, stopLoss: draft.stopLoss ? formatTradablePrice(Number(draft.stopLoss)) : draft.stopLoss } }))} onChange={(event) => setPendingOrderDrafts((drafts: any) => ({ ...drafts, [order.id]: { ...draft, stopLoss: event.target.value } }))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-red outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                          <label className="mt-1 flex items-center justify-end gap-1.5 text-xs text-terminal-muted">
                            <input checked={isTrailing} onChange={(event) => setPendingOrderDrafts((drafts: any) => ({ ...drafts, [order.id]: { ...draft, trailingStop: event.target.checked } }))} type="checkbox" className="h-3.5 w-3.5 accent-terminal-blue" />
                            Trailing {isTrailing ? formatPrice(draftTrailDistance) : ""}
                          </label>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <input value={draft.targetPrice} onBlur={() => setPendingOrderDrafts((drafts: any) => ({ ...drafts, [order.id]: { ...draft, targetPrice: draft.targetPrice ? formatTradablePrice(Number(draft.targetPrice)) : draft.targetPrice } }))} onChange={(event) => setPendingOrderDrafts((drafts: any) => ({ ...drafts, [order.id]: { ...draft, targetPrice: event.target.value } }))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-emerald outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                        </td>
                        <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(order.createdAt)}</td>
                        <td className="px-3 py-3 text-right">
                          <span className={`rounded border px-2 py-1 text-xs font-semibold ${willFill ? "border-terminal-emerald/70 bg-terminal-emerald/10 text-terminal-emerald" : "border-terminal-amber/70 bg-terminal-amber/10 text-terminal-amber"}`}>
                            {willFill ? "Ready" : order.status}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-2">
                            <button className="h-9 rounded border border-terminal-blue/70 bg-terminal-blue/10 px-3 text-xs font-semibold text-terminal-blue transition hover:bg-terminal-blue hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={updatingPendingOrderId === order.id || cancelingPendingOrderId === order.id || draftEntry <= 0 || draftTargetPrice <= 0} type="button" onClick={() => handleUpdatePendingOrder(order.id)}>
                              {updatingPendingOrderId === order.id ? "Saving" : "Save"}
                            </button>
                            <button className="h-9 rounded border border-terminal-red/70 bg-terminal-red/10 px-3 text-xs font-semibold text-terminal-red transition hover:bg-terminal-red hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={updatingPendingOrderId === order.id || cancelingPendingOrderId === order.id} type="button" onClick={() => handleCancelPendingOrder(order.id)}>
                              {cancelingPendingOrderId === order.id ? "Canceling" : "Cancel"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {paperSummary && !pendingPaperOrders.length ? (
                    <tr><td colSpan={11} className="px-3 py-6 text-center text-terminal-muted">No pending paper orders.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {activeTab === "closed" ? (
          <div className="rounded border border-terminal-line bg-white/[0.03]">
            <PaperSectionHeader title="Closed Trades" meta={`${formatCurrency(paperSummary?.stats.realizedPnl ?? 0)} realized`} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                  <tr>
                    <th className="px-3 py-3 text-left">Trade</th>
                    <th className="px-3 py-3 text-left">Reason</th>
                    <th className="px-3 py-3 text-right">Entry Time</th>
                    <th className="px-3 py-3 text-right">Entry</th>
                    <th className="px-3 py-3 text-right">SL</th>
                    <th className="px-3 py-3 text-right">Target</th>
                    <th className="px-3 py-3 text-right">Exit</th>
                    <th className="px-3 py-3 text-right">Qty</th>
                    <th className="px-3 py-3 text-right">Charges</th>
                    <th className="px-3 py-3 text-right">Net P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {(paperSummary?.closedTrades ?? []).map((trade: any) => (
                    <tr key={trade.id} className="border-t border-terminal-line/80">
                      <td className="px-3 py-3">
                        <div className="font-semibold">{trade.underlyingSymbol} {formatStrike(trade.strikePrice)} {trade.optionType}</div>
                        <div className="text-xs text-terminal-muted">{trade.expiry} / {trade.action}</div>
                        {trade.ownerEmail ? <div className="text-xs text-terminal-blue">{trade.ownerName ?? trade.ownerEmail}</div> : null}
                      </td>
                      <td className="px-3 py-3 text-terminal-muted">{trade.exitReason}</td>
                      <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(trade.openedAt)}</td>
                      <td className="px-3 py-3 text-right">{formatPrice(trade.entryPrice)}</td>
                      <td className="px-3 py-3 text-right text-terminal-red">{formatPrice(trade.stopLoss)}</td>
                      <td className="px-3 py-3 text-right text-terminal-emerald">{formatPrice(trade.targetPrice)}</td>
                      <td className="px-3 py-3 text-right">{formatPrice(trade.exitPrice)}</td>
                      <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(trade.lots, trade.lotSize, trade.quantity)}</td>
                      <td className="px-3 py-3 text-right text-terminal-muted">{formatCurrency(-Math.abs(trade.charges))}</td>
                      <td className={`px-3 py-3 text-right font-semibold ${trade.netPnl >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>{formatCurrency(trade.netPnl)}</td>
                    </tr>
                  ))}
                  {paperSummary && !paperSummary.closedTrades.length ? (
                    <tr><td colSpan={10} className="px-3 py-6 text-center text-terminal-muted">No closed trades yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {activeTab === "summary" ? (
          <div className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-4">
              <SignalCell label="Entry Trigger" value={formatPrice(orderEntryPrice)} detail={`${orderAction === "BUY" ? "BUY fills when LTP <= entry" : "SELL fills when LTP >= entry"} / LTP ${formatPrice(marketEntryPrice)}`} tone="blue" />
              <SignalCell label="Risk / Reward" value={riskReward ? `1:${riskReward.toFixed(1)}` : "--"} detail={`${formatCurrency(estimatedRisk)} trail risk`} tone="green" />
              <SignalCell label="Target Payoff" value={formatCurrency(estimatedReward)} detail={`${formatPrice(orderTargetValue)} target`} tone="green" />
              <SignalCell label="Net Delta Exposure" value={formatDeltaExposure(totalOpenDeltaExposure)} detail={`${openCount} open position${openCount === 1 ? "" : "s"}`} tone={totalOpenDeltaExposure > 0.5 ? "green" : totalOpenDeltaExposure < -0.5 ? "red" : "blue"} />
            </div>

            <div className="rounded border border-terminal-line bg-white/[0.03]">
              <PaperSectionHeader title="Recent Filled Orders" meta={`${paperSummary?.stats.filledOrders ?? 0} filled`} />
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                    <tr>
                      <th className="px-3 py-3 text-left">Order</th>
                      <th className="px-3 py-3 text-right">Qty</th>
                      <th className="px-3 py-3 text-right">Price</th>
                      <th className="px-3 py-3 text-right">SL</th>
                      <th className="px-3 py-3 text-right">Target</th>
                      <th className="px-3 py-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentPaperOrders.slice(0, 10).map((order: any) => (
                      <tr key={order.id} className="border-t border-terminal-line/80">
                        <td className="px-3 py-3">
                          <div className="font-semibold">{order.underlyingSymbol} {formatStrike(order.strikePrice)} {order.optionType}</div>
                          <div className="text-xs text-terminal-muted">{order.expiry} / {formatIstShortDateTime(order.createdAt)}</div>
                          {order.ownerEmail ? <div className="text-xs text-terminal-blue">{order.ownerName ?? order.ownerEmail}</div> : null}
                        </td>
                        <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(order.lots, order.lotSize, order.quantity)}</td>
                        <td className="px-3 py-3 text-right">{formatPrice(order.filledPrice ?? order.requestedPrice)}</td>
                        <td className="px-3 py-3 text-right text-terminal-red">{formatPrice(order.stopLoss)}</td>
                        <td className="px-3 py-3 text-right text-terminal-emerald">{formatPrice(order.targetPrice)}</td>
                        <td className="px-3 py-3 text-right text-terminal-emerald">{order.status}</td>
                      </tr>
                    ))}
                    {paperSummary && !recentPaperOrders.length ? (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-terminal-muted">No filled paper orders yet.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TabButton({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 rounded border px-3 text-sm font-semibold transition ${active ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line text-terminal-muted hover:border-terminal-blue hover:text-terminal-text"}`}
    >
      {label}
      {count !== undefined ? <span className="ml-1.5 text-xs text-terminal-muted">{count}</span> : null}
    </button>
  );
}

function KpiChip({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "blue" | "emerald" | "amber" | "red" }) {
  const toneClass = tone === "emerald" ? "text-terminal-emerald" : tone === "amber" ? "text-terminal-amber" : tone === "red" ? "text-terminal-red" : tone === "blue" ? "text-terminal-blue" : "text-terminal-text";

  return (
    <span className="flex items-baseline gap-1.5 rounded border border-terminal-line/70 bg-terminal-panel/95 px-2.5 py-1.5">
      <span className="text-xs uppercase text-terminal-muted">{label}</span>
      <span className={`text-sm font-semibold ${toneClass}`}>{value}</span>
    </span>
  );
}

function TicketField({ label, children, align = "left" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase text-terminal-muted">{label}</span>
      <div className={align === "right" ? "text-right" : ""}>{children}</div>
    </div>
  );
}

function SignalCell({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "blue" | "green" | "red" }) {
  const toneClass = tone === "green" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <p className="text-xs uppercase text-terminal-muted">{label}</p>
      <p className={`mt-2 text-lg font-semibold ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs text-terminal-muted">{detail}</p>
    </div>
  );
}

function formatDelta(value?: number) {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(2);
}

function formatDeltaExposure(value?: number) {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(0)}`;
}

function deltaToneClass(value?: number) {
  if (value === undefined || Math.abs(value) < 0.5) {
    return "text-terminal-muted";
  }
  return value > 0 ? "text-terminal-emerald" : "text-terminal-red";
}

function deltaTone(value?: number): "default" | "emerald" | "red" {
  if (value === undefined || Math.abs(value) < 0.5) {
    return "default";
  }
  return value > 0 ? "emerald" : "red";
}

function PaperSectionHeader({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-line px-3 py-3">
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-terminal-muted">{meta}</span>
    </div>
  );
}
