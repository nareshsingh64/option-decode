CREATE INDEX `OCT_session_contract_time_idx` ON `OptionContractTick`(`underlyingSymbol`, `expiryLabel`, `tradingDate`, `optionType`, `strikePrice`, `tickTime`);
