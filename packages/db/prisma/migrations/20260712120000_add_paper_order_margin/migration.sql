-- Informational-only margin estimate at order placement time (not just at
-- fill). Works outside market hours since Dhan's margin calculator is a
-- static SPAN/exposure lookup, not a live quote.
ALTER TABLE `PaperOrder` ADD COLUMN `marginRequired` DECIMAL(14, 2) NULL;
ALTER TABLE `PaperOrder` ADD COLUMN `marginBreakdown` JSON NULL;
