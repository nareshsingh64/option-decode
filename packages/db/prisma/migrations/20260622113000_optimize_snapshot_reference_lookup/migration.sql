CREATE INDEX `OCS_underlying_expiry_day_time_idx`
  ON `OptionChainSnapshot`(`underlyingSymbol`, `expiryId`, `tradingDate`, `snapshotTime`);

CREATE INDEX `OCT_snapshot_idx`
  ON `OptionContractTick`(`snapshotId`);
