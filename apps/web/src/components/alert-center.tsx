"use client";

import { BellRing } from "lucide-react";

type AlertFilter = "all" | "critical" | "warning" | "info" | "dismissed";

interface AlertItem {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  metric: string;
  createdAt: string;
}

interface AlertCenterProps {
  mode: "dashboard" | "alerts";
  alerts: AlertItem[];
  displayedAlerts: AlertItem[];
  activeAlertCount: number;
  dismissedAlertIds: string[];
  alertFilter: AlertFilter;
  alertCenterHref: string;
  onFilterChange: (filter: AlertFilter) => void;
  onDismissAlert: (alertId: string) => void;
  onRestoreAlert: (alertId: string) => void;
  formatTime: (value: string) => string;
}

export function AlertCenter({
  mode,
  alerts,
  displayedAlerts,
  activeAlertCount,
  dismissedAlertIds,
  alertFilter,
  alertCenterHref,
  onFilterChange,
  onDismissAlert,
  onRestoreAlert,
  formatTime
}: AlertCenterProps) {
  const isFullCenter = mode === "alerts";

  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">{isFullCenter ? "Alert Center" : "Live Alerts"}</h2>
      <div className="mt-4 grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {isFullCenter ? (
            <div className="flex flex-wrap gap-2">
              {(["all", "critical", "warning", "info", "dismissed"] as const).map((filter) => (
                <button key={filter} className={`min-h-9 rounded border px-3 py-1.5 text-xs font-semibold uppercase transition ${alertFilter === filter ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line text-terminal-muted hover:border-terminal-blue hover:text-terminal-text"}`} type="button" onClick={() => onFilterChange(filter)}>
                  {filter}
                </button>
              ))}
            </div>
          ) : (
            <a className="flex min-h-9 items-center rounded border border-terminal-line px-3 py-1.5 text-xs font-semibold uppercase text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-blue" href={alertCenterHref}>
              Open Alert Center
            </a>
          )}
          <div className="text-sm text-terminal-muted">
            <span className="font-semibold text-terminal-text">{activeAlertCount}</span> active / {alerts.length} total
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {displayedAlerts.map((alert) => {
            const dismissed = dismissedAlertIds.includes(alert.id);

            return (
              <div key={alert.id} className={`rounded border p-3 ${alert.severity === "critical" ? "border-terminal-red/70 bg-terminal-red/10" : alert.severity === "warning" ? "border-terminal-amber/70 bg-terminal-amber/10" : "border-terminal-blue/50 bg-terminal-blue/10"} ${dismissed ? "opacity-60" : ""}`}>
                <div className="flex items-start gap-2">
                  <BellRing size={16} className={alert.severity === "critical" ? "mt-0.5 shrink-0 text-terminal-red" : alert.severity === "warning" ? "mt-0.5 shrink-0 text-terminal-amber" : "mt-0.5 shrink-0 text-terminal-blue"} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{alert.title}</p>
                      <span className="rounded border border-white/10 px-1.5 py-0.5 text-[0.65rem] uppercase text-terminal-muted">{alert.severity}</span>
                      {dismissed ? <span className="rounded border border-terminal-line px-1.5 py-0.5 text-[0.65rem] uppercase text-terminal-muted">dismissed</span> : null}
                    </div>
                    <p className="mt-1 text-sm text-terminal-muted">{alert.message}</p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <p className="text-xs text-terminal-muted">{formatTime(alert.createdAt)} IST</p>
                      <button className="min-h-8 rounded border border-terminal-line px-2 py-1 text-xs text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="button" onClick={() => (dismissed ? onRestoreAlert(alert.id) : onDismissAlert(alert.id))}>
                        {dismissed ? "Restore" : "Dismiss"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {!displayedAlerts.length ? <p className="rounded border border-terminal-line bg-white/[0.03] px-3 py-4 text-center text-sm text-terminal-muted md:col-span-2 xl:col-span-3">{isFullCenter ? "No alerts in this filter." : "No active alerts."}</p> : null}
        </div>
      </div>
    </section>
  );
}
