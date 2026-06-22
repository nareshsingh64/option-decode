export default function AppLoading() {
  return (
    <main className="min-h-screen bg-terminal-bg px-3 py-3 text-terminal-text sm:px-4 lg:px-5">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-terminal-line/80 pb-3">
        <div>
          <p className="text-xs font-semibold uppercase text-terminal-emerald">Option Decode</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">Loading Trading Workspace</h1>
        </div>
        <div className="h-10 w-28 animate-pulse rounded border border-terminal-line bg-terminal-panel" />
      </header>

      <div className="grid gap-4 py-3 lg:grid-cols-[14.5rem_minmax(0,1fr)] xl:grid-cols-[15.5rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-terminal-line pr-3 lg:block">
          <div className="space-y-2">
            {["Dashboard", "Option Chain", "Pressure Engine", "Paper Trading", "Settings"].map((item) => (
              <div key={item} className="h-10 animate-pulse rounded border border-terminal-line bg-terminal-panel/80" />
            ))}
          </div>
        </aside>

        <section className="grid min-w-0 gap-4">
          <div className="h-20 animate-pulse rounded border border-terminal-line bg-terminal-panel/80" />
          <div className="grid gap-3 md:grid-cols-4">
            {["Spot", "Bullish", "Bearish", "PCR"].map((item) => (
              <div key={item} className="h-24 animate-pulse rounded border border-terminal-line bg-terminal-panel/80" />
            ))}
          </div>
          <div className="h-[28rem] animate-pulse rounded border border-terminal-line bg-terminal-panel/80" />
        </section>
      </div>
    </main>
  );
}
