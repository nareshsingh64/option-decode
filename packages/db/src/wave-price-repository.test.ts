import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { isUniqueConstraintError } from "./wave-price-repository.ts";

test("isUniqueConstraintError recognizes Prisma's unique-constraint violation code (P2002)", () => {
  const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });
  assert.equal(isUniqueConstraintError(error), true);
});

test("isUniqueConstraintError rejects other Prisma known-request error codes", () => {
  const error = new Prisma.PrismaClientKnownRequestError("Record not found", { code: "P2025", clientVersion: "6.19.3" });
  assert.equal(isUniqueConstraintError(error), false);
});

test("isUniqueConstraintError rejects plain errors and non-error values", () => {
  assert.equal(isUniqueConstraintError(new Error("some other failure")), false);
  assert.equal(isUniqueConstraintError("a string, not an error"), false);
  assert.equal(isUniqueConstraintError(undefined), false);
});
