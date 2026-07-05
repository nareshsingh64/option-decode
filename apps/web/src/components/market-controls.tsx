import { Play, Plus, RefreshCw } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { CalendarDatePicker } from "./calendar-date-picker";

interface MarketTickerItem {
  symbol: string;
  displayName: string;
  segment: string;
  spotPrice?: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
}

interface MarketControlsProps {
  overview: any;
  watchlist: any;
  watchlistError: string | null;
  newWatchSymbol: string;
  setNewWatchSymbol: (value: string) => void;
  lastRefresh: string;
  initialView: string;
  isRefreshing: boolean;
  formatIstShortDateTime: (value: string) => string;
  loadMarketSelection: (symbol: string) => Promise<void>;
  handleMarketControlSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleAddWatchSymbol: (event: FormEvent<HTMLFormElement>) => void;
  refreshOverview: () => void;
}

export function MarketControls({
  overview,
  watchlist,
  watchlistError,
  newWatchSymbol,
  setNewWatchSymbol,
  lastRefresh,
  initialView,
  isRefreshing,
  formatIstShortDateTime,
  loadMarketSelection,
  handleMarketControlSubmit,
  handleAddWatchSymbol,
  refreshOverview
}: MarketControlsProps) {
  return (
    <>
      <MarketTicker items={overview.ticker ?? []} />

      <section className="flex flex-wrap items-end justify-between gap-3 rounded border border-terminal-line bg-terminal-panel/80 p-3">
        <div>
          <h2 className="text-base font-semibold">Market Controls</h2>
          <p className="mt-1 text-sm text-terminal-muted">Last refresh {formatIstShortDateTime(lastRefresh)} IST</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1 text-xs uppercase text-terminal-muted">
            Watchlist
            <div className="flex gap-2">
              <input list="watchlist-symbols" value={newWatchSymbol} onChange={(event) => setNewWatchSymbol(event.target.value)} className="h-10 min-w-36 rounded border border-terminal-line bg-terminal-input px-3 text-sm uppercase text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="Search list" />
              <datalist id="watchlist-symbols">
                {(watchlist?.symbols ?? overview.underlyings).map((symbol: string) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
              </datalist>
              <button className="grid h-10 w-10 place-items-center rounded border border-terminal-blue bg-terminal-blue text-white transition hover:opacity-90" type="button" onClick={() => {
                const symbol = newWatchSymbol.trim().toUpperCase();
                if (symbol) {
                  void loadMarketSelection(symbol);
                }
              }} aria-label="Open watchlist symbol">
                <Play size={15} />
              </button>
            </div>
          </div>
          <form key={`${overview.selectedUnderlying}-${overview.selectedExpiry}`} className="flex flex-wrap gap-3" onSubmit={handleMarketControlSubmit}>
            <input name="view" type="hidden" value={initialView} />
            <label className="grid gap-1 text-xs uppercase text-terminal-muted">
              Symbol
              <input name="underlying" list="underlying-symbols" defaultValue={overview.selectedUnderlying} className="h-10 min-w-40 rounded border border-terminal-line bg-terminal-input px-3 text-sm uppercase text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="NIFTY, CRUDEOIL..." />
              <datalist id="underlying-symbols">
                {overview.underlyings.map((underlying: string) => (
                  <option key={underlying} value={underlying}>
                    {underlying}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="grid gap-1 text-xs uppercase text-terminal-muted">
              Expiry
              {/* A separate child component (rather than local state right
                  here) so the surrounding form's key={selectedUnderlying-
                  selectedExpiry} remount resets its staged value, the same
                  way the old defaultValue-based <select> used to. */}
              <ExpiryFormField expiries={overview.expiries} initialValue={overview.selectedExpiry} name="expiry" />
            </label>
            <button className="h-10 rounded border border-terminal-blue bg-terminal-blue px-4 text-sm font-semibold text-white transition hover:opacity-90" type="submit">
              Apply
            </button>
          </form>
          <form className="flex gap-2" onSubmit={handleAddWatchSymbol}>
            <input value={newWatchSymbol} onChange={(event) => setNewWatchSymbol(event.target.value)} className="h-10 w-28 rounded border border-terminal-line bg-terminal-input px-3 text-sm uppercase text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="Add" />
            <button className="grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="submit" aria-label="Add watchlist symbol">
              <Plus size={16} />
            </button>
          </form>
          <button className="grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="button" onClick={refreshOverview} aria-label="Refresh market data">
            <RefreshCw size={17} className={isRefreshing ? "animate-spin" : ""} />
          </button>
        </div>
        {watchlistError ? <p className="basis-full text-sm text-terminal-red">{watchlistError}</p> : null}
      </section>
    </>
  );
}

// Stages the picked expiry locally until the surrounding form submits.
// Declared as its own component (rather than useState directly inside
// MarketControls) so the parent form's key={selectedUnderlying-
// selectedExpiry} remount - which already exists to reset the old
// uncontrolled <select>'s defaultValue - also resets this staged value the
// same way when the underlying/expiry changes from elsewhere (e.g. the
// watchlist "Play" button).
function ExpiryFormField({ expiries, initialValue, name }: { expiries: string[]; initialValue: string; name: string }) {
  const [value, setValue] = useState(initialValue);
  return <CalendarDatePicker availableDates={expiries} value={value} onChange={setValue} name={name} placeholder="Select expiry" emptyLabel="No stored expiries available yet." />;
}

function MarketTicker({ items }: { items: MarketTickerItem[] }) {
  const visibleItems = items.length ? items : [{ symbol: "NIFTY", displayName: "NIFTY", segment: "IDX_I" }];
  const tickerItems = [...visibleItems, ...visibleItems];

  return (
    <section className="overflow-hidden rounded border border-terminal-line bg-terminal-panel/90" aria-label="Market ticker">
      <div className="flex border-b border-terminal-line/70 px-3 py-2 text-xs font-semibold uppercase text-terminal-muted">
        <span>Market Ticker</span>
      </div>
      <div className="relative overflow-hidden py-2">
        <div className="market-ticker-track flex w-max gap-2 px-2">
          {tickerItems.map((item, index) => {
            const change = item.change ?? 0;
            const hasChange = item.change !== undefined && item.changePercent !== undefined;
            const toneClass = !hasChange ? "text-terminal-muted" : change >= 0 ? "text-terminal-emerald" : "text-terminal-red";
            const sign = change > 0 ? "+" : "";

            return (
              <div key={`${item.symbol}-${index}`} className="flex min-w-max items-center gap-2 rounded border border-terminal-line bg-terminal-input px-3 py-1.5 text-sm">
                <span className="font-semibold text-terminal-text">{item.displayName}</span>
                <span className="text-terminal-muted">{formatPrice(item.spotPrice)}</span>
                <span className={`font-semibold ${toneClass}`}>
                  {hasChange ? `${sign}${formatPrice(change)} (${sign}${item.changePercent?.toFixed(2)}%)` : "Chg --"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function formatPrice(value?: number) {
  return value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
