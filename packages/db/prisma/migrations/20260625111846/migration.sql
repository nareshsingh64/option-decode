-- RenameIndex
ALTER TABLE `OptionChainSnapshot` RENAME INDEX `OCS_underlying_expiry_day_time_idx` TO `OptionChainSnapshot_underlyingSymbol_expiryId_tradingDate_sn_idx`;

-- RenameIndex
ALTER TABLE `OptionChainSnapshot` RENAME INDEX `OCS_underlying_snapshot_idx` TO `OptionChainSnapshot_underlyingSymbol_snapshotTime_idx`;

-- RenameIndex
ALTER TABLE `OptionContractTick` RENAME INDEX `OCT_chain_prev_tick_idx` TO `OptionContractTick_underlyingSymbol_expiryLabel_optionType_s_idx`;

-- RenameIndex
ALTER TABLE `OptionContractTick` RENAME INDEX `OCT_session_contract_time_idx` TO `OptionContractTick_underlyingSymbol_expiryLabel_tradingDate__idx`;

-- RenameIndex
ALTER TABLE `OptionContractTick` RENAME INDEX `OCT_snapshot_idx` TO `OptionContractTick_snapshotId_idx`;

-- RenameIndex
ALTER TABLE `PaperOrder` RENAME INDEX `PO_user_created_idx` TO `PaperOrder_userId_createdAt_idx`;

-- RenameIndex
ALTER TABLE `PaperPosition` RENAME INDEX `PP_user_status_opened_idx` TO `PaperPosition_userId_status_openedAt_idx`;

-- RenameIndex
ALTER TABLE `PaperTrade` RENAME INDEX `PT_closed_idx` TO `PaperTrade_closedAt_idx`;
