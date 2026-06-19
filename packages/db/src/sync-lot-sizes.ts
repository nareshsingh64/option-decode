import { syncFnoLotSizesFromDhan } from "./lot-size-repository.js";

const result = await syncFnoLotSizesFromDhan();
console.log(`Synced ${result.rowsStored} F&O lot-size rows for ${result.symbolsStored} symbols from ${result.sourceUrl}`);
