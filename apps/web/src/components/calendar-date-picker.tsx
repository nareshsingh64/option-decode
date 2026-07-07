import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Generic calendar-style date picker used everywhere the dashboard lets
 * you pick a date from a constrained, known set (option expiries in
 * Market Controls / Replay Lab, and trading days in Replay Lab). Unlike a
 * plain <select>, this only lets you land on dates that actually have
 * stored data - every other day on the calendar is rendered but disabled,
 * so it's visually obvious what's available without scrolling a flat
 * dropdown list.
 *
 * Fully controlled (value + onChange), matching how every other form
 * control in this app already works. When `name` is set, it also renders a
 * hidden input so it can drop into an existing native <form> (see
 * market-controls.tsx) without changing how that form is submitted/read.
 *
 * The popover itself is rendered through a portal into document.body
 * (positioned via the trigger button's own bounding rect) rather than as a
 * plain `position: absolute` child. This picker now also gets used inside
 * the Paper Order Ticket, whose table sits in an `overflow-x-auto`
 * wrapper - and setting overflow-x on an element makes the browser clip
 * overflow-y too (a standard CSS behavior, not a bug in that wrapper), so
 * a plain absolutely-positioned popover got silently clipped/hidden there.
 * Escaping via a portal sidesteps that regardless of which ancestor might
 * clip in the future.
 */
interface CalendarDatePickerProps {
  availableDates: string[];
  value: string;
  onChange: (date: string) => void;
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  emptyLabel?: string;
}

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function parseIsoDate(value: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(value: string, placeholder: string): string {
  const date = parseIsoDate(value);
  if (!date) return value || placeholder;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function CalendarDatePicker({ availableDates, value, onChange, name, disabled, placeholder = "Select a date", emptyLabel = "No dates available yet." }: CalendarDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(null);

  const availableSet = useMemo(() => new Set(availableDates), [availableDates]);
  const sortedDates = useMemo(() => [...availableDates].sort(), [availableDates]);

  const fallbackAnchor = parseIsoDate(value) ?? parseIsoDate(sortedDates[0] ?? "") ?? new Date();
  const [viewYear, setViewYear] = useState(fallbackAnchor.getFullYear());
  const [viewMonth, setViewMonth] = useState(fallbackAnchor.getMonth());

  // Re-anchor to the selected (or first available) month every time the
  // picker opens, so switching underlyings/expiries while it's closed
  // doesn't leave it showing a stale month next time it's opened.
  useEffect(() => {
    if (!isOpen) return;
    const anchor = parseIsoDate(value) ?? parseIsoDate(sortedDates[0] ?? "") ?? new Date();
    setViewYear(anchor.getFullYear());
    setViewMonth(anchor.getMonth());
    // Only re-anchor on open, not on every value/availableDates change
    // while open - otherwise picking a date in an adjacent month would
    // immediately snap the calendar away right as it closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Popover is portaled to document.body (see component doc comment above),
  // so it's no longer a DOM descendant of containerRef - a click inside it
  // has to be excluded separately or it would look like an "outside" click
  // and close itself immediately.
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    // The popover's position is computed once, on open (below). Rather than
    // tracking every scroll/resize to keep it glued to the trigger, just
    // close it if the page scrolls or resizes while it's open - simpler,
    // and avoids ever showing a stale-positioned popover. `capture: true`
    // is needed to hear scroll events from nested scrollable containers
    // (like the Paper Order Ticket's horizontally-scrolling table), since
    // scroll events don't bubble.
    function handleScrollOrResize() {
      setIsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen]);

  // Computes where the portaled popover should render, anchored to the
  // trigger button's current position, clamped so it can't run off the
  // right edge of the viewport.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) {
      setPopoverPosition(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = 256; // matches w-64
    setPopoverPosition({
      top: rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - popoverWidth - 8)
    });
  }, [isOpen]);

  const monthStart = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const leadingBlanks = monthStart.getDay();
  const cells: (Date | null)[] = [...Array.from({ length: leadingBlanks }, () => null), ...Array.from({ length: daysInMonth }, (_, index) => new Date(viewYear, viewMonth, index + 1))];

  // Keep month navigation bounded to the range that actually contains
  // available dates, so there's no way to page into an empty month with
  // nothing selectable.
  const monthKeys = sortedDates.map((dateValue) => {
    const parsed = parseIsoDate(dateValue)!;
    return parsed.getFullYear() * 12 + parsed.getMonth();
  });
  const currentMonthKey = viewYear * 12 + viewMonth;
  const minMonthKey = monthKeys.length ? Math.min(...monthKeys) : currentMonthKey;
  const maxMonthKey = monthKeys.length ? Math.max(...monthKeys) : currentMonthKey;
  const canGoPrev = currentMonthKey > minMonthKey;
  const canGoNext = currentMonthKey < maxMonthKey;

  function goToMonth(delta: number) {
    const nextKey = currentMonthKey + delta;
    setViewYear(Math.floor(nextKey / 12));
    setViewMonth(((nextKey % 12) + 12) % 12);
  }

  function selectDate(date: Date) {
    const iso = toIsoDate(date);
    if (!availableSet.has(iso)) return;
    onChange(iso);
    setIsOpen(false);
  }

  return (
    <div className="relative" ref={containerRef}>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((open) => !open)}
        className="flex h-10 w-full min-w-40 items-center gap-2 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none transition focus:border-terminal-blue disabled:opacity-50"
      >
        <CalendarDays size={15} className="shrink-0 text-terminal-muted" />
        <span className="truncate">{formatDisplayDate(value, placeholder)}</span>
      </button>

      {isOpen && popoverPosition
        ? createPortal(
            <div
              ref={popoverRef}
              style={{ position: "fixed", top: popoverPosition.top, left: popoverPosition.left }}
              className="z-50 w-64 rounded border border-terminal-line bg-terminal-panel p-3 shadow-lg"
            >
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => goToMonth(-1)} disabled={!canGoPrev} className="grid h-7 w-7 place-items-center rounded text-terminal-muted transition hover:bg-white/[0.06] hover:text-terminal-text disabled:opacity-30" aria-label="Previous month">
                  <ChevronLeft size={16} />
                </button>
                <span className="text-sm font-semibold text-terminal-text">{monthStart.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</span>
                <button type="button" onClick={() => goToMonth(1)} disabled={!canGoNext} className="grid h-7 w-7 place-items-center rounded text-terminal-muted transition hover:bg-white/[0.06] hover:text-terminal-text disabled:opacity-30" aria-label="Next month">
                  <ChevronRight size={16} />
                </button>
              </div>
              <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[0.65rem] uppercase text-terminal-muted">
                {WEEKDAY_LABELS.map((weekday) => (
                  <span key={weekday}>{weekday}</span>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-1">
                {cells.map((date, index) => {
                  if (!date) return <span key={`blank-${index}`} />;
                  const iso = toIsoDate(date);
                  const isAvailable = availableSet.has(iso);
                  const isSelected = iso === value;
                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={!isAvailable}
                      onClick={() => selectDate(date)}
                      className={
                        "grid h-7 w-7 place-items-center rounded text-xs transition " +
                        (isSelected ? "bg-terminal-blue font-semibold text-white" : isAvailable ? "text-terminal-text hover:bg-terminal-blue/20" : "cursor-not-allowed text-terminal-muted/30")
                      }
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
              {!sortedDates.length ? <p className="mt-2 text-xs text-terminal-muted">{emptyLabel}</p> : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
