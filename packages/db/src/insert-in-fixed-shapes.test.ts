import { test } from "node:test";
import assert from "node:assert/strict";
import { insertInFixedShapes } from "./insert-in-fixed-shapes.ts";

function recordingCreateMany<T>(calls: T[][]) {
  return async (batch: T[]) => {
    calls.push(batch);
    return { count: batch.length };
  };
}

function recordingCreateOne<T>(calls: T[]) {
  return async (row: T) => {
    calls.push(row);
    return row;
  };
}

test("insertInFixedShapes does nothing for an empty array", async () => {
  const manyCalls: number[][] = [];
  const oneCalls: number[] = [];
  const count = await insertInFixedShapes([], 50, recordingCreateMany(manyCalls), recordingCreateOne(oneCalls));

  assert.equal(count, 0);
  assert.deepEqual(manyCalls, []);
  assert.deepEqual(oneCalls, []);
});

test("a row count under the chunk size skips createMany entirely and uses only createOne", async () => {
  const manyCalls: number[][] = [];
  const oneCalls: number[] = [];
  const rows = [1, 2, 3];
  const count = await insertInFixedShapes(rows, 50, recordingCreateMany(manyCalls), recordingCreateOne(oneCalls));

  assert.equal(count, 3);
  assert.deepEqual(manyCalls, [], "createMany must never be called with a variable-sized batch");
  assert.deepEqual(oneCalls, [1, 2, 3]);
});

test("a row count exactly equal to the chunk size is a single fixed-size createMany with no remainder", async () => {
  const manyCalls: number[][] = [];
  const oneCalls: number[] = [];
  const rows = Array.from({ length: 50 }, (_, i) => i);
  const count = await insertInFixedShapes(rows, 50, recordingCreateMany(manyCalls), recordingCreateOne(oneCalls));

  assert.equal(count, 50);
  assert.equal(manyCalls.length, 1);
  assert.equal(manyCalls[0]?.length, 50);
  assert.deepEqual(oneCalls, [], "an exact multiple of the chunk size must not fall through to createOne");
});

test("a row count above the chunk size splits into fixed-size createMany batches plus a createOne remainder", async () => {
  const manyCalls: number[][] = [];
  const oneCalls: number[] = [];
  const rows = Array.from({ length: 137 }, (_, i) => i);
  const count = await insertInFixedShapes(rows, 50, recordingCreateMany(manyCalls), recordingCreateOne(oneCalls));

  assert.equal(count, 137);
  assert.equal(manyCalls.length, 2, "137 rows / 50 = 2 full chunks");
  for (const batch of manyCalls) {
    assert.equal(batch.length, 50, "every createMany call must be exactly the fixed chunk size");
  }
  assert.equal(oneCalls.length, 37, "the remainder (137 - 100) must go through createOne");
  assert.deepEqual(
    rows,
    [...manyCalls.flat(), ...oneCalls],
    "every row must be inserted exactly once, in order, with none dropped or duplicated"
  );
});

test("multiple full chunks with no remainder never touch createOne", async () => {
  const manyCalls: number[][] = [];
  const oneCalls: number[] = [];
  const rows = Array.from({ length: 150 }, (_, i) => i);
  await insertInFixedShapes(rows, 50, recordingCreateMany(manyCalls), recordingCreateOne(oneCalls));

  assert.equal(manyCalls.length, 3);
  assert.deepEqual(oneCalls, []);
});

test("without an ignorable-error predicate, a createOne failure propagates", async () => {
  const manyCalls: number[][] = [];
  const failing = async () => {
    throw new Error("boom");
  };

  await assert.rejects(() => insertInFixedShapes([1, 2, 3], 50, recordingCreateMany(manyCalls), failing), /boom/);
});

test("an ignorable createOne error (e.g. a duplicate-key violation) is swallowed and excluded from the count", async () => {
  const manyCalls: number[][] = [];
  let call = 0;
  const createOne = async (row: number) => {
    call += 1;
    if (row === 2) {
      throw new Error("duplicate key");
    }
    return row;
  };

  const count = await insertInFixedShapes([1, 2, 3], 50, recordingCreateMany(manyCalls), createOne, (error) => error instanceof Error && error.message === "duplicate key");

  assert.equal(call, 3, "every row must still be attempted even after an earlier one is swallowed");
  assert.equal(count, 2, "the swallowed duplicate must not be counted as inserted");
});

test("a non-ignorable error still propagates even when a predicate is supplied", async () => {
  const manyCalls: number[][] = [];
  const failing = async () => {
    throw new Error("not a duplicate");
  };

  await assert.rejects(
    () => insertInFixedShapes([1], 50, recordingCreateMany(manyCalls), failing, (error) => error instanceof Error && error.message === "duplicate key"),
    /not a duplicate/
  );
});
