-- One OPEN position per contract per account - and any number of CLOSED ones.
--
-- The previous unique key was (accountId, securityId, status), which also meant
-- only ONE CLOSED row per contract could ever exist. A contract sold, closed,
-- and sold again could not be closed a second time: the UPDATE violated the
-- key, threw inside the reconcile sweep, and stopped the account reconciling
-- entirely.
--
-- openSlot is GENERATED, so it cannot drift from status: it is the securityId
-- while the row is OPEN and NULL once it is CLOSED. MySQL permits unlimited
-- NULLs in a unique index, so closed history is unconstrained while the open
-- guarantee is kept.
ALTER TABLE `LivePosition`
  ADD COLUMN `openSlot` VARCHAR(191)
    GENERATED ALWAYS AS (IF(`status` = 'OPEN', `securityId`, NULL)) STORED;

DROP INDEX `LivePosition_accountId_securityId_status_key` ON `LivePosition`;

CREATE UNIQUE INDEX `LivePosition_accountId_openSlot_key`
  ON `LivePosition` (`accountId`, `openSlot`);

-- Kept as a plain index: the reconcile sweep still looks rows up by this
-- triple, it just no longer needs it to be unique.
CREATE INDEX `LivePosition_accountId_securityId_status_idx`
  ON `LivePosition` (`accountId`, `securityId`, `status`);
