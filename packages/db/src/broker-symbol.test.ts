import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBrokerTradingSymbol } from "./live-repository.js";

// Real symbols from the account. The reconciler stored only the underlying and
// left optionType/strikePrice null, which stayed invisible until square-off
// built a closing order from them and recorded "NIFTY 0 CE".
test("a Dhan option symbol yields underlying, strike and type", () => {
  assert.deepEqual(parseBrokerTradingSymbol("NIFTY-Sep2026-24100-CE"), {
    underlyingSymbol: "NIFTY",
    strikePrice: 24100,
    optionType: "CE"
  });
  assert.deepEqual(parseBrokerTradingSymbol("NIFTY-Sep2026-24800-PE"), {
    underlyingSymbol: "NIFTY",
    strikePrice: 24800,
    optionType: "PE"
  });
});

test("a commodity symbol parses the same way", () => {
  assert.deepEqual(parseBrokerTradingSymbol("CRUDEOIL-Sep2026-6000-CE"), {
    underlyingSymbol: "CRUDEOIL",
    strikePrice: 6000,
    optionType: "CE"
  });
});

test("a non-option symbol yields the underlying and nothing invented", () => {
  // A futures or equity position must not come back with a strike of 0 and a
  // fabricated CE - that is precisely the failure being fixed.
  const parsed = parseBrokerTradingSymbol("RELIANCE");
  assert.equal(parsed.underlyingSymbol, "RELIANCE");
  assert.equal(parsed.strikePrice, undefined);
  assert.equal(parsed.optionType, undefined);
});

test("a malformed or missing symbol returns empty rather than throwing", () => {
  assert.deepEqual(parseBrokerTradingSymbol(undefined), {});
  assert.deepEqual(parseBrokerTradingSymbol(""), {});
  assert.equal(parseBrokerTradingSymbol("NIFTY-Sep2026-notanumber-CE").strikePrice, undefined);
});
