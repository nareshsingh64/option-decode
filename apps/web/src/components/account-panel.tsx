import { LineChart, LogOut, ShieldCheck, UserCircle, WalletCards } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import type { AuthUser } from "./live-dashboard";

interface AccountPanelProps {
  authDisplayName: string;
  authEmail: string;
  authError: string | null;
  authMessage: string | null;
  authMode: "login" | "register";
  authPassword: string;
  authUser?: AuthUser | null;
  formatIstShortDateTime: (value: string) => string;
  handleAuthSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleLogout: () => void;
  handleResendVerification: () => void;
  isAuthSubmitting: boolean;
  setAuthDisplayName: (value: string) => void;
  setAuthEmail: (value: string) => void;
  setAuthError: (value: string | null) => void;
  setAuthMessage: (value: string | null) => void;
  setAuthMode: (value: "login" | "register") => void;
  setAuthPassword: (value: string) => void;
}

export function AccountPanel({
  authDisplayName,
  authEmail,
  authError,
  authMessage,
  authMode,
  authPassword,
  authUser,
  formatIstShortDateTime,
  handleAuthSubmit,
  handleLogout,
  handleResendVerification,
  isAuthSubmitting,
  setAuthDisplayName,
  setAuthEmail,
  setAuthError,
  setAuthMessage,
  setAuthMode,
  setAuthPassword
}: AccountPanelProps) {
  return (
    <Panel title="Account">
      <div className={authUser ? "grid gap-4" : "grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.45fr)]"}>
        <div className="grid gap-4 rounded border border-terminal-line bg-white/[0.03] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded border border-terminal-blue/60 bg-terminal-blue/15 text-terminal-blue">
                <UserCircle size={22} />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-terminal-muted">Current User</p>
                <h2 className="mt-1 text-lg font-semibold text-terminal-text">{authUser?.displayName || authUser?.email || "Not signed in"}</h2>
              </div>
            </div>
            {authUser ? (
              <button className="flex min-h-9 items-center gap-2 rounded border border-terminal-line px-3 py-1.5 text-sm text-terminal-muted transition hover:border-terminal-red hover:text-terminal-red disabled:cursor-not-allowed disabled:opacity-50" disabled={isAuthSubmitting} type="button" onClick={handleLogout}>
                <LogOut size={15} />
                Sign out
              </button>
            ) : null}
          </div>

          {authUser ? (
            <div className="grid gap-3 md:grid-cols-3">
              <SignalCell label="Role" value={authUser.role} detail={authUser.emailVerified ? "Email verified" : "Email pending"} tone="blue" />
              <SignalCell label="Plan" value={authUser.plan?.name ?? "No plan"} detail={authUser.plan?.status ?? "Inactive"} tone="green" />
              <SignalCell label="Replay Limit" value={authUser.plan?.replayLimit === undefined ? "Unlimited" : String(authUser.plan.replayLimit)} detail={authUser.plan?.realtime ? "Realtime enabled" : "Delayed tier"} tone="blue" />
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              <StatusTile icon={<ShieldCheck size={18} />} label="Trial Access" value="14 days" />
              <StatusTile icon={<LineChart size={18} />} label="Analytics" value="Starter" />
              <StatusTile icon={<WalletCards size={18} />} label="Paper Trades" value="Ready" />
            </div>
          )}

          {authUser && !authUser.emailVerified ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-terminal-amber/50 bg-terminal-amber/10 px-3 py-3">
              <div>
                <p className="text-sm font-semibold text-terminal-amber">Email verification pending</p>
                <p className="mt-1 text-xs text-terminal-muted">Verify your email to keep account recovery and security controls active.</p>
              </div>
              <button className="h-9 rounded border border-terminal-amber/70 px-3 text-xs font-semibold text-terminal-amber transition hover:bg-terminal-amber hover:text-terminal-bg disabled:cursor-not-allowed disabled:opacity-50" disabled={isAuthSubmitting} type="button" onClick={handleResendVerification}>
                Resend Verification
              </button>
            </div>
          ) : null}

          {authUser ? (
            <div className="grid gap-2 text-sm">
              <SummaryLine label="Email" value={authUser.email} />
              <SummaryLine label="Last login" value={authUser.lastLoginAt ? formatIstShortDateTime(authUser.lastLoginAt) : "--"} />
              <SummaryLine label="Plan code" value={authUser.plan?.code ?? "--"} />
              <SummaryLine label="Premium alerts" value={authUser.plan?.premiumAlerts ? "Enabled" : "Not enabled"} />
              <SummaryLine label="Realtime market feed" value={authUser.plan?.realtime ? "Enabled" : "Plan limited"} />
            </div>
          ) : (
            <p className="text-sm leading-6 text-terminal-muted">Create a trial account to start saving preferences and prepare the app for subscription-based access to replay, alerts, and live modules.</p>
          )}
        </div>

        {/* The login/register form is only for signed-out visitors. A
            signed-in user must not be able to create additional accounts
            from here - registration for new users is an admin/onboarding
            concern, not a self-service action inside a live session. */}
        {authUser ? null : (
        <form className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-4" onSubmit={handleAuthSubmit}>
          <div className="flex rounded border border-terminal-line bg-terminal-input p-1 text-sm">
            <button className={`min-h-9 flex-1 rounded px-3 font-semibold transition ${authMode === "login" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => {
              setAuthMode("login");
              setAuthError(null);
              setAuthMessage(null);
            }}>
              Login
            </button>
            <button className={`min-h-9 flex-1 rounded px-3 font-semibold transition ${authMode === "register" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => {
              setAuthMode("register");
              setAuthError(null);
              setAuthMessage(null);
            }}>
              Register
            </button>
          </div>
          {authMode === "register" ? (
            <label className="grid gap-1 text-xs uppercase text-terminal-muted">
              Name
              <input value={authDisplayName} onChange={(event) => setAuthDisplayName(event.target.value)} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="Your name" />
            </label>
          ) : null}
          <label className="grid gap-1 text-xs uppercase text-terminal-muted">
            Email
            <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="name@example.com" type="email" />
          </label>
          <label className="grid gap-1 text-xs uppercase text-terminal-muted">
            Password
            <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm text-terminal-text outline-none transition focus:border-terminal-blue" minLength={8} placeholder="Minimum 8 characters" type="password" />
          </label>
          <button className="h-10 rounded border border-terminal-emerald bg-terminal-emerald px-4 text-sm font-semibold text-terminal-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" disabled={isAuthSubmitting} type="submit">
            {isAuthSubmitting ? "Working..." : authMode === "register" ? "Create Trial Account" : "Login"}
          </button>
          {authError ? <p className="text-sm text-terminal-red">{authError}</p> : null}
          {authMessage ? <p className="text-sm text-terminal-emerald">{authMessage}</p> : null}
        </form>
        )}
      </div>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
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

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-line/70 pb-2 last:border-b-0 last:pb-0">
      <span className="text-terminal-muted">{label}</span>
      <span className="text-right font-semibold text-terminal-text">{value}</span>
    </div>
  );
}

function StatusTile({ icon, label, value, detail, tone = "blue" }: { icon: ReactNode; label: string; value: string; detail?: string; tone?: "blue" | "green" | "red" }) {
  const toneClass = tone === "green" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <div className={`flex items-center gap-2 ${toneClass}`}>{icon}</div>
      <p className="mt-3 text-xs uppercase text-terminal-muted">{label}</p>
      <p className={`mt-1 font-semibold ${toneClass}`}>{value}</p>
      {detail ? <p className="mt-1 text-xs text-terminal-muted">{detail}</p> : null}
    </div>
  );
}
