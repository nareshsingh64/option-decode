import { LineChart, Play, RefreshCw, ShieldCheck, UserCircle, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AdminOverview } from "./live-dashboard";
import { fetchSimAdminAccounts } from "./dashboard-client";
import type { SimAdminAccountRow } from "./dashboard-client";

// Role-based tab access: the assignable tab set and its display labels.
// Mirrors ASSIGNABLE_TABS/TAB_LABELS in @option-decode/db. Dashboard,
// Strike Matrix, Option Chain, and Paper Trading are the defaults for
// users without an explicit assignment; admins always see everything.
const ASSIGNABLE_TAB_LABELS: Array<[string, string]> = [
  ["dashboard", "Dashboard"],
  ["new-dashboard", "Strike Matrix"],
  ["elliott-wave", "Elliott Wave"],
  ["option-chain", "Option Chain"],
  ["pressure", "Pressure Engine"],
  ["replay", "Replay Lab"],
  ["paper", "Paper Trading"],
  ["paper-pro", "Paper Trading Pro"],
  ["live-order", "Live Orders"],
  ["alerts", "Alerts"]
];

interface AdminPanelProps {
  adminError: string | null;
  adminOverview: AdminOverview | null;
  formatCurrency: (value: number) => string;
  formatIstShortDateTime: (value: string) => string;
  handleUpdateAdminUserDisabled: (userId: string, disabled: boolean) => void;
  handleUpdateAdminUserRole: (userId: string, role: AdminOverview["users"][number]["role"]) => void;
  handleUpdateAdminUserTabs: (userId: string, tabs: string[]) => void;
  refreshAdminOverview: () => void;
  updatingAdminUserId: string | null;
}

export function AdminPanel({
  adminError,
  adminOverview,
  formatCurrency,
  formatIstShortDateTime,
  handleUpdateAdminUserDisabled,
  handleUpdateAdminUserRole,
  handleUpdateAdminUserTabs,
  refreshAdminOverview,
  updatingAdminUserId
}: AdminPanelProps) {
  return (
    <Panel title="Admin Console">
      <div className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-terminal-muted">Protected Admin Area</p>
            <h2 className="mt-1 text-lg font-semibold text-terminal-text">Users, plans, and platform status</h2>
          </div>
          <button className="h-9 rounded border border-terminal-blue/70 bg-terminal-blue/10 px-3 text-xs font-semibold text-terminal-blue transition hover:bg-terminal-blue hover:text-white" type="button" onClick={refreshAdminOverview}>
            Refresh Admin Data
          </button>
        </div>

        {adminError ? <p className="rounded border border-terminal-red/50 bg-terminal-red/10 px-3 py-2 text-terminal-red">{adminError}</p> : null}

        <div className="grid gap-3 md:grid-cols-5">
          <StatusTile icon={<UserCircle size={18} />} label="Users" value={String(adminOverview?.metrics.users ?? 0)} />
          <StatusTile icon={<ShieldCheck size={18} />} label="Admins" value={String(adminOverview?.metrics.admins ?? 0)} />
          <StatusTile icon={<WalletCards size={18} />} label="Subscriptions" value={String(adminOverview?.metrics.activeSubscriptions ?? 0)} />
          <StatusTile icon={<LineChart size={18} />} label="Snapshots Today" value={String(adminOverview?.metrics.snapshotsToday ?? 0)} />
          <StatusTile icon={<Play size={18} />} label="Open Paper" value={String(adminOverview?.metrics.openPaperPositions ?? 0)} />
        </div>

        <div className="rounded border border-terminal-line bg-white/[0.03]">
          <PaperSectionHeader title="Users" meta={`${adminOverview?.users.length ?? 0} latest`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] border-collapse text-sm">
              <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                <tr>
                  <th className="px-3 py-3 text-left">User</th>
                  <th className="px-3 py-3 text-left">Plan</th>
                  <th className="px-3 py-3 text-left">Role</th>
                  <th className="px-3 py-3 text-left">Tabs</th>
                  <th className="px-3 py-3 text-right">Verified</th>
                  <th className="px-3 py-3 text-right">Status</th>
                  <th className="px-3 py-3 text-right">Last Login</th>
                  <th className="px-3 py-3 text-right">Created</th>
                  <th className="px-3 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {(adminOverview?.users ?? []).map((user) => (
                  <tr key={user.id} className="border-t border-terminal-line/80">
                    <td className="px-3 py-3">
                      <div className="font-semibold text-terminal-text">{user.displayName || user.email}</div>
                      <div className="text-xs text-terminal-muted">{user.email}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-semibold text-terminal-text">{user.plan?.name ?? "--"}</div>
                      <div className="text-xs text-terminal-muted">{user.plan?.status ?? "No subscription"}</div>
                    </td>
                    <td className="px-3 py-3">
                      <select value={user.role} onChange={(event) => handleUpdateAdminUserRole(user.id, event.target.value as AdminOverview["users"][number]["role"])} className="h-9 rounded border border-terminal-line bg-terminal-input px-2 text-sm text-terminal-text outline-none focus:border-terminal-blue" disabled={updatingAdminUserId === user.id}>
                        <option value="ADMIN">ADMIN</option>
                        <option value="SUBSCRIBER">SUBSCRIBER</option>
                        <option value="TRIAL">TRIAL</option>
                        <option value="FREE">FREE</option>
                      </select>
                    </td>
                    <td className="px-3 py-3">
                      {user.role === "ADMIN" ? (
                        <span className="text-xs text-terminal-muted">All tabs (admin)</span>
                      ) : (
                        <div className="grid max-w-[16rem] grid-cols-2 gap-x-3 gap-y-1">
                          {ASSIGNABLE_TAB_LABELS.map(([tab, label]) => (
                            <label key={tab} className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-terminal-muted">
                              <input
                                checked={user.tabs.includes(tab)}
                                className="h-3.5 w-3.5 accent-[rgb(96,165,250)]"
                                disabled={updatingAdminUserId === user.id}
                                type="checkbox"
                                onChange={(event) => {
                                  const nextTabs = event.target.checked ? [...user.tabs, tab] : user.tabs.filter((existing) => existing !== tab);
                                  handleUpdateAdminUserTabs(user.id, nextTabs);
                                }}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-3 text-right font-semibold ${user.emailVerified ? "text-terminal-emerald" : "text-terminal-amber"}`}>{user.emailVerified ? "Yes" : "No"}</td>
                    <td className={`px-3 py-3 text-right font-semibold ${user.disabled ? "text-terminal-red" : "text-terminal-emerald"}`}>{user.disabled ? "Disabled" : "Active"}</td>
                    <td className="px-3 py-3 text-right text-xs text-terminal-muted">{user.lastLoginAt ? formatIstShortDateTime(user.lastLoginAt) : "--"}</td>
                    <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(user.createdAt)}</td>
                    <td className="px-3 py-3 text-right">
                      <button className={`h-9 rounded border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${user.disabled ? "border-terminal-emerald/70 bg-terminal-emerald/10 text-terminal-emerald hover:bg-terminal-emerald hover:text-terminal-bg" : "border-terminal-red/70 bg-terminal-red/10 text-terminal-red hover:bg-terminal-red hover:text-white"}`} disabled={updatingAdminUserId === user.id} type="button" onClick={() => handleUpdateAdminUserDisabled(user.id, !user.disabled)}>
                        {updatingAdminUserId === user.id ? "Saving..." : user.disabled ? "Enable" : "Disable"}
                      </button>
                    </td>
                  </tr>
                ))}
                {adminOverview && !adminOverview.users.length ? (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-terminal-muted">No users found.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded border border-terminal-line bg-white/[0.03]">
          <PaperSectionHeader title="Plans" meta={`${adminOverview?.plans.length ?? 0} tiers`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] border-collapse text-sm">
              <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                <tr>
                  <th className="px-3 py-3 text-left">Plan</th>
                  <th className="px-3 py-3 text-right">Monthly</th>
                  <th className="px-3 py-3 text-right">Replay</th>
                  <th className="px-3 py-3 text-right">Realtime</th>
                  <th className="px-3 py-3 text-right">Premium Alerts</th>
                  <th className="px-3 py-3 text-right">Subscriptions</th>
                </tr>
              </thead>
              <tbody>
                {(adminOverview?.plans ?? []).map((plan) => (
                  <tr key={plan.id} className="border-t border-terminal-line/80">
                    <td className="px-3 py-3">
                      <div className="font-semibold text-terminal-text">{plan.name}</div>
                      <div className="text-xs text-terminal-muted">{plan.code}</div>
                    </td>
                    <td className="px-3 py-3 text-right">{formatCurrency(plan.monthlyPrice ?? 0)}</td>
                    <td className="px-3 py-3 text-right">{plan.replayLimit === undefined ? "Unlimited" : plan.replayLimit}</td>
                    <td className={`px-3 py-3 text-right font-semibold ${plan.realtime ? "text-terminal-emerald" : "text-terminal-muted"}`}>{plan.realtime ? "Yes" : "No"}</td>
                    <td className={`px-3 py-3 text-right font-semibold ${plan.premiumAlerts ? "text-terminal-emerald" : "text-terminal-muted"}`}>{plan.premiumAlerts ? "Yes" : "No"}</td>
                    <td className="px-3 py-3 text-right">{plan.subscriberCount}</td>
                  </tr>
                ))}
                {adminOverview && !adminOverview.plans.length ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-terminal-muted">No plans found.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <SimAccountsSection formatCurrency={formatCurrency} formatIstShortDateTime={formatIstShortDateTime} />
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

function PaperSectionHeader({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-line px-3 py-3">
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-terminal-muted">{meta}</span>
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

// Paper Trade Pro oversight. READ ONLY - there are no controls here, and that
// is deliberate: an admin can see any user's simulator account but cannot
// close a trade or reset a balance. The API has no endpoint for it either, so
// this is not merely a UI omission.
//
// Fetches its own data rather than being handed it, because the admin overview
// payload is loaded on every visit to this tab and simulator accounts are only
// interesting when someone actually opens this section.
function SimAccountsSection({ formatCurrency, formatIstShortDateTime }: {
  formatCurrency: (value: number) => string;
  formatIstShortDateTime: (value: string) => string;
}) {
  const [rows, setRows] = useState<SimAdminAccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchSimAdminAccounts());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load simulator accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mt-4 rounded border border-terminal-line bg-terminal-panel p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">
          Paper Trade Pro accounts
          {rows ? <span className="ml-2 font-normal normal-case tracking-normal text-terminal-muted/70">{rows.length} with activity</span> : null}
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1 rounded border border-terminal-line px-2 py-1 text-[0.65rem] uppercase text-terminal-muted hover:text-terminal-text"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      <p className="mt-1 text-[0.65rem] text-terminal-muted/80">
        Read-only. Only users who have opened the simulator appear here. Unrealised P&amp;L is deliberately absent -
        marking open positions costs a quote per leg, so it is not computed for a list.
      </p>

      {error ? <p className="mt-2 text-xs text-terminal-red">{error}</p> : null}
      {loading && !rows ? <p className="mt-2 text-xs text-terminal-muted">Loading...</p> : null}

      {rows && rows.length > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-terminal-muted/70">
                <th className="py-1 pr-2 font-medium">User</th>
                <th className="py-1 pr-2 font-medium">Role</th>
                <th className="py-1 pr-2 text-right font-medium">Open</th>
                <th className="py-1 pr-2 text-right font-medium">Closed</th>
                <th className="py-1 pr-2 text-right font-medium">Realised P&amp;L</th>
                <th className="py-1 pr-2 text-right font-medium">Cash</th>
                <th className="py-1 pr-2 font-medium">Last trade</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.accountId} className="border-b border-terminal-line/40">
                  <td className="py-1.5 pr-2 text-terminal-text">
                    {row.displayName ?? row.email}
                    {row.displayName ? <span className="ml-1 text-terminal-muted">{row.email}</span> : null}
                    {row.disabled ? <span className="ml-1 text-terminal-red">(disabled)</span> : null}
                  </td>
                  <td className="py-1.5 pr-2 text-terminal-muted">{row.role}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.openTrades}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.closedTrades}</td>
                  <td className={`py-1.5 pr-2 text-right font-semibold tabular-nums ${row.realizedPnl >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>
                    {formatCurrency(row.realizedPnl)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-terminal-muted">{formatCurrency(row.cash)}</td>
                  <td className="py-1.5 pr-2 text-terminal-muted">
                    {row.lastTradeAt ? formatIstShortDateTime(row.lastTradeAt) : "never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows && rows.length === 0 ? (
        <p className="mt-2 text-xs text-terminal-muted">No user has opened the simulator yet.</p>
      ) : null}
    </div>
  );
}
