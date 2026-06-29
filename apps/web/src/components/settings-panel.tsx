import type { ReactNode } from "react";

interface SettingsPanelProps {
  alertSettingsStatus: string | null;
  alertThresholdDraft: any;
  authUser: any;
  disableBrowserPush: () => void;
  enableBrowserPush: () => void;
  fitScreenMode: boolean;
  isPushSubmitting: boolean;
  isSavingAlertThresholds: boolean;
  numberFormatMode: "indian" | "metric";
  overview: any;
  pushStatus: string | null;
  quantityDisplayMode: "lots" | "numbers";
  saveAlertThresholds: () => void;
  setAlertThresholdDraft: (updater: any) => void;
  setFitScreenMode?: (enabled: boolean) => void;
  setNumberFormatMode: (value: "indian" | "metric") => void;
  setQuantityDisplayMode: (value: "lots" | "numbers") => void;
  setVisibleStrikeMode: (value: "vix" | "atm") => void;
  visibleStrikeMode: "vix" | "atm";
}

export function SettingsPanel({
  alertSettingsStatus,
  alertThresholdDraft,
  authUser,
  disableBrowserPush,
  enableBrowserPush,
  fitScreenMode,
  isPushSubmitting,
  isSavingAlertThresholds,
  numberFormatMode,
  overview,
  pushStatus,
  quantityDisplayMode,
  saveAlertThresholds,
  setAlertThresholdDraft,
  setFitScreenMode,
  setNumberFormatMode,
  setQuantityDisplayMode,
  setVisibleStrikeMode,
  visibleStrikeMode
}: SettingsPanelProps) {
  return (
    <div className="grid gap-4">
      <Panel title="Settings">
        <div className="grid gap-4 md:grid-cols-2">
          <SettingsSwitch
            label="Number Format"
            leftLabel="L"
            rightLabel="M"
            checked={numberFormatMode === "metric"}
            onChange={(checked) => setNumberFormatMode(checked ? "metric" : "indian")}
            detail={numberFormatMode === "metric" ? "Uses K, M, B scaling" : "Uses K, L, Cr scaling"}
          />
          <SettingsSwitch
            label="OI / Volume Values"
            leftLabel="Contracts"
            rightLabel="Numbers"
            checked={quantityDisplayMode === "numbers"}
            onChange={(checked) => setQuantityDisplayMode(checked ? "numbers" : "lots")}
            detail={quantityDisplayMode === "numbers" ? "Shows raw exchange quantity" : "Shows contract-normalized values"}
          />
          <SettingsSwitch
            label="Visible Strikes"
            leftLabel="VIX"
            rightLabel="ATM"
            checked={visibleStrikeMode === "atm"}
            onChange={(checked) => setVisibleStrikeMode(checked ? "atm" : "vix")}
            detail={visibleStrikeMode === "atm" ? "Shows ATM +/- 6 strikes" : "Shows India VIX expected range"}
          />
          <SettingsSwitch
            label="Fit Screen"
            leftLabel="Off"
            rightLabel="On"
            checked={fitScreenMode}
            onChange={(checked) => setFitScreenMode?.(checked)}
            detail={fitScreenMode ? "Keeps the workspace inside the screen with internal table scrolling" : "Uses normal page scrolling"}
          />
        </div>
      </Panel>
      <Panel title="Alert Thresholds">
        <div className="grid gap-3 md:grid-cols-5">
          <SettingsNumberField label="Near Level Pts" value={alertThresholdDraft.proximityPoints} onChange={(value) => setAlertThresholdDraft((draft: any) => ({ ...draft, proximityPoints: value }))} />
          <SettingsNumberField label="PCR Upper" value={alertThresholdDraft.pcrUpper} step="0.01" onChange={(value) => setAlertThresholdDraft((draft: any) => ({ ...draft, pcrUpper: value }))} />
          <SettingsNumberField label="PCR Lower" value={alertThresholdDraft.pcrLower} step="0.01" onChange={(value) => setAlertThresholdDraft((draft: any) => ({ ...draft, pcrLower: value }))} />
          <SettingsNumberField label="Pressure Warn %" value={alertThresholdDraft.pressureWarning} onChange={(value) => setAlertThresholdDraft((draft: any) => ({ ...draft, pressureWarning: value }))} />
          <SettingsNumberField label="Pressure Critical %" value={alertThresholdDraft.pressureCritical} onChange={(value) => setAlertThresholdDraft((draft: any) => ({ ...draft, pressureCritical: value }))} />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-terminal-muted">Applies to {overview.selectedUnderlying}. Change the Market Control symbol to edit another underlying.</p>
          <button className="rounded bg-terminal-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-terminal-blue/80 disabled:cursor-not-allowed disabled:opacity-60" disabled={!authUser || isSavingAlertThresholds} type="button" onClick={saveAlertThresholds}>
            {isSavingAlertThresholds ? "Saving..." : "Save Thresholds"}
          </button>
        </div>
        {alertSettingsStatus ? <p className="mt-3 text-sm text-terminal-muted">{alertSettingsStatus}</p> : null}
      </Panel>
      <Panel title="Browser Notifications">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-terminal-muted">Critical market alerts can be delivered by browser push when this device grants permission.</p>
          <div className="flex flex-wrap gap-2">
            <button className="rounded border border-terminal-blue px-4 py-2 text-sm font-semibold text-terminal-blue transition hover:bg-terminal-blue/10 disabled:cursor-not-allowed disabled:opacity-60" disabled={!authUser || isPushSubmitting} type="button" onClick={enableBrowserPush}>
              {isPushSubmitting ? "Working..." : "Enable Push"}
            </button>
            <button className="rounded border border-terminal-red px-4 py-2 text-sm font-semibold text-terminal-red transition hover:bg-terminal-red/10 disabled:cursor-not-allowed disabled:opacity-60" disabled={!authUser || isPushSubmitting} type="button" onClick={disableBrowserPush}>
              Disable Push
            </button>
          </div>
        </div>
        {pushStatus ? <p className="mt-3 text-sm text-terminal-muted">{pushStatus}</p> : null}
      </Panel>
    </div>
  );
}

function SettingsSwitch({ label, leftLabel, rightLabel, checked, onChange, detail }: { label: string; leftLabel: string; rightLabel: string; checked: boolean; onChange: (checked: boolean) => void; detail: string }) {
  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-semibold text-terminal-text">{label}</p>
          <p className="mt-1 text-sm text-terminal-muted">{detail}</p>
        </div>
        <label className="flex h-10 shrink-0 items-center rounded border border-terminal-line bg-terminal-input p-1 text-xs font-semibold uppercase text-terminal-muted">
          <span className={`rounded px-2 py-1.5 ${!checked ? "bg-terminal-blue text-white" : ""}`}>{leftLabel}</span>
          <input className="sr-only" checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
          <span className={`rounded px-2 py-1.5 ${checked ? "bg-terminal-blue text-white" : ""}`}>{rightLabel}</span>
        </label>
      </div>
    </div>
  );
}

function SettingsNumberField({ label, value, step = "1", onChange }: { label: string; value: string; step?: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="text-xs uppercase text-terminal-muted">{label}</span>
      <input
        className="h-10 rounded border border-terminal-line bg-terminal-input px-3 font-semibold text-terminal-text outline-none focus:border-terminal-blue"
        min="0"
        step={step}
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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
