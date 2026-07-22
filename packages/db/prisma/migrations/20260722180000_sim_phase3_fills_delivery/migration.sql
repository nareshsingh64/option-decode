-- Paper Trading Pro Phase 3: partial-fill breakdown + delivery-risk rule.
-- Touches Sim* tables only.

-- AlterTable
ALTER TABLE `SimLeg` ADD COLUMN `fillBreakdown` JSON NULL;

-- AlterTable
ALTER TABLE `SimExitEvent` MODIFY `rule` ENUM('PROFIT_TARGET', 'HARD_STOP_3X', 'DTE_GAMMA', 'EXPIRY_ITM', 'DELTA_2X_INTRADAY', 'MARGIN_CALL', 'DELIVERY_RISK') NOT NULL;
