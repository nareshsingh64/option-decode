import { VerifyEmailFormShell } from "../forgot-password/password-forms";

export default function VerifyEmailPage() {
  return (
    <main className="relative grid min-h-screen overflow-hidden bg-slate-950 text-white lg:grid-cols-[minmax(0,1fr)_minmax(24rem,30rem)]">
      <div className="absolute inset-0 bg-[url('/landing/fintech-trading-hero.png')] bg-cover bg-center" aria-hidden="true" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,7,18,0.92)_0%,rgba(3,7,18,0.76)_46%,rgba(3,7,18,0.88)_100%)]" aria-hidden="true" />
      <section className="relative z-10 flex min-h-screen flex-col justify-between px-5 py-5 sm:px-7 lg:px-10">
        <a href="/login" className="text-lg font-semibold tracking-[0.18em] text-white">
          OPTION DECODE
        </a>
        <div className="max-w-2xl py-12">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-emerald-300">Email verification</p>
          <h1 className="mt-5 text-5xl font-semibold leading-[1.04] text-white sm:text-6xl">Confirm Your Account Email</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-slate-200">We are verifying your registration link before opening the secured trading workspace.</p>
        </div>
        <footer className="text-sm text-slate-300">
          <p>Copyright © {new Date().getFullYear()} PyTrade. All rights reserved.</p>
          <p className="mt-1">info@pytrade.co.in · Support: Support@pytrade.co.in</p>
        </footer>
      </section>
      <aside className="relative z-10 flex items-center px-5 py-8 sm:px-7 lg:px-10">
        <VerifyEmailFormShell />
      </aside>
    </main>
  );
}
