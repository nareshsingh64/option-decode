import type { ReactNode } from "react";

export function PaperTradingPanel({ children }: { children: ReactNode }) {
  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">Paper Trading</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
