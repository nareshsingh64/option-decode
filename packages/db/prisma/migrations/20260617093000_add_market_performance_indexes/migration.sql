CREATE INDEX `OCS_underlying_snapshot_idx` ON `OptionChainSnapshot`(`underlyingSymbol`, `snapshotTime`);

CREATE INDEX `OCT_chain_prev_tick_idx` ON `OptionContractTick`(`underlyingSymbol`, `expiryLabel`, `optionType`, `strikePrice`, `tickTime`);

CREATE INDEX `PO_user_created_idx` ON `PaperOrder`(`userId`, `createdAt`);

CREATE INDEX `PP_user_status_opened_idx` ON `PaperPosition`(`userId`, `status`, `openedAt`);

CREATE INDEX `PT_closed_idx` ON `PaperTrade`(`closedAt`);
