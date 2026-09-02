import assert from "node:assert/strict";
import { test } from "node:test";

import { newestOpeningGroupBySecurityId } from "./live-repository.js";

// The real sequence from 2026-09-02, newest first, which is how the engine
// fetches it. NIFTY 24100 CE (securityId 42643) was sold, closed, and sold
// again the same day; the 24700 CE (42669) was traded once.
const REAL_ORDERS = [
  { securityId: "42643", groupId: "26e199bc" }, // 07:34 sell at 58.00  <- live
  { securityId: "42643", groupId: null },       // 06:20 CLOSE, no group
  { securityId: "42643", groupId: "86e90efe" }, // 06:19 sell at 51.80  <- settled
  { securityId: "42669", groupId: "b08c0bda" }  // 06:17 buy
];

test("a contract re-traded the same day belongs to its NEWEST group", () => {
  const newest = newestOpeningGroupBySecurityId(REAL_ORDERS);
  // The settled 06:19 group must NOT own the position opened at 07:34. Getting
  // this wrong gave one open short two competing trigger sets - a profit target
  // at 29.00 from the real fill and 25.90 from a trade already closed.
  assert.equal(newest.get("42643"), "26e199bc");
  assert.notEqual(newest.get("42643"), "86e90efe");
  assert.equal(newest.get("42669"), "b08c0bda");
});

test("closing orders never own a contract", () => {
  // A CLOSE order carries no groupId - all 12 in production are null - and
  // must not be able to claim a contract, or the newest entry for a
  // re-traded leg would be the close rather than the reopen.
  const closesOnly = [{ securityId: "42643", groupId: null }];
  assert.equal(newestOpeningGroupBySecurityId(closesOnly).size, 0);
});

test("order matters: the input must be newest-first", () => {
  // Documents the contract rather than defending it - the function cannot know
  // the ordering was wrong, so the query that feeds it must keep placedAt DESC.
  const oldestFirst = [...REAL_ORDERS].reverse();
  assert.equal(newestOpeningGroupBySecurityId(oldestFirst).get("42643"), "86e90efe");
});

test("an untraded contract has no owning group", () => {
  assert.equal(newestOpeningGroupBySecurityId(REAL_ORDERS).get("99999"), undefined);
});
