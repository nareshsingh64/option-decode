import { ArrowRight, BarChart3, LockKeyhole, ShieldCheck, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";

const currentYear = new Date().getFullYear();

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-terminal-bg text-white">
      <section className="relative flex min-h-[92vh] overflow-hidden bg-slate-950">
        <div className="absolute inset-0 bg-[url('/landing/fintech-trading-hero.png')] bg-cover bg-center" aria-hidden="true" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,7,18,0.92)_0%,rgba(3,7,18,0.78)_37%,rgba(3,7,18,0.42)_68%,rgba(3,7,18,0.66)_100%)]" aria-hidden="true" />
        <div className="relative z-10 flex min-h-[92vh] w-full flex-col">
          <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:px-7 lg:px-10">
            <a href="/" className="text-lg font-semibold tracking-[0.18em] text-white">
              OPTION DECODE
            </a>
            <nav className="flex items-center gap-2 text-sm font-semibold">
              <a className="rounded border border-white/20 bg-white/10 px-4 py-2 text-white backdrop-blur transition hover:border-white/45 hover:bg-white/15" href="/login">
                Login
              </a>
              <a className="rounded border border-emerald-400 bg-emerald-400 px-4 py-2 text-slate-950 transition hover:opacity-90" href="/register">
                Register
              </a>
            </nav>
          </header>

          <div className="mx-auto grid w-full max-w-7xl flex-1 content-center gap-8 px-5 pb-14 pt-6 sm:px-7 lg:px-10">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-emerald-300">Premium fintech trading analytics</p>
              <h1 className="mt-5 max-w-3xl text-5xl font-semibold leading-[1.02] text-white sm:text-6xl lg:text-7xl">Option Decode</h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-200 sm:text-xl">
                Read option-chain pressure, strike movement score, market breadth, replay snapshots, and paper trades from one focused command center built for Indian index, equity derivative, and commodity markets.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a className="inline-flex h-12 items-center gap-2 rounded border border-emerald-400 bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:opacity-90" href="/register">
                  Create account
                  <ArrowRight size={17} />
                </a>
                <a className="inline-flex h-12 items-center gap-2 rounded border border-white/25 bg-white/10 px-5 text-sm font-semibold text-white backdrop-blur transition hover:border-white/50 hover:bg-white/15" href="/login">
                  Login to app
                  <LockKeyhole size={17} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-terminal-bg px-5 py-10 text-terminal-text sm:px-7 lg:px-10">
        <div className="mx-auto grid max-w-7xl gap-4 md:grid-cols-3">
          <Feature icon={<TrendingUp size={20} />} title="Pressure Engine" text="Track support and resistance pressure across ATM ranges, OI, volume, and change signals." />
          <Feature icon={<BarChart3 size={20} />} title="Replay Lab" text="Review saved snapshots by expiry and time to study how a setup developed during the session." />
          <Feature icon={<ShieldCheck size={20} />} title="Paper Trading" text="Practice entries, pending orders, trailing SL, target logic, and closed-trade review before going live." />
        </div>
      </section>

      <footer className="border-t border-terminal-line bg-terminal-panel px-5 py-6 text-sm text-terminal-muted sm:px-7 lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p>Copyright © {currentYear} PyTrade. All rights reserved.</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <a className="transition hover:text-terminal-text" href="mailto:info@pytrade.co.in">info@pytrade.co.in</a>
            <a className="transition hover:text-terminal-text" href="mailto:Support@pytrade.co.in">Support: Support@pytrade.co.in</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Feature({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <article className="rounded border border-terminal-line bg-terminal-panel p-5">
      <div className="mb-4 grid h-10 w-10 place-items-center rounded border border-terminal-blue/40 bg-terminal-blue/10 text-terminal-blue">{icon}</div>
      <h2 className="text-base font-semibold text-terminal-text">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-terminal-muted">{text}</p>
    </article>
  );
}
