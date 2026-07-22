import { LineChart, Play, ShieldCheck, UserCircle, WalletCards } from "lucide-react";
import type { ReactNode } from "react";
import type { AdminOverview } from "./live-dashboard";

// Role-based tab access: the assignable tab set and its display labels.
// Mirrors ASSIGNABLE_TABS/TAB_LABELS in @option-decode/db. Dashboard,
// Strike Matrix, Option Chain, and Paper Trading are the defaults for
// users without an explicit assignment; admins always see everything.
const ASSIGNABLE_TAB_LABELS: Array<[string, string]> = [
  ["dashboard", "Dashboard"],
  ["new-dashboard", "Strike Matrix"],
  ["option-chain", "Option Chain"],
  ["pressure", "Pressure Engine"],
  ["replay", "Replay Lab"],
  ["paper", "Paper Trading"],
  ["paper-pro", "Paper Trading Pro"],
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
