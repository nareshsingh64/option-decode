// Moved to calendar-date-picker.tsx and renamed to CalendarDatePicker once
// it started being reused for trading-day selection too, not just expiry
// dates. Re-exported here (rather than deleted) since this sandbox can't
// delete files from the connected folder - safe to remove this file by
// hand once nothing references the old name.
export { CalendarDatePicker as ExpiryDatePicker } from "./calendar-date-picker";
