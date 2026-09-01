import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// Every model in the COMMITTED schema must have a migration that is also
// committed.
//
// This exists because the same mistake happened twice. schema.prisma carries
// work in progress - a model added locally whose migration is still untracked -
// and any commit that stages the whole file sweeps the model in without it. The
// result is a committed schema declaring a table that no committed migration
// creates, which then ships to production and does not exist in the database.
//
// Nothing caught it either time. It is not a type error, no test touched it,
// `prisma validate` passes because the schema is internally valid, and
// `migrate deploy` does not care - it only applies migrations it has. The drift
// stays dormant until something queries the table, which is the worst kind of
// wrong: invisible until it is expensive.
//
// EVERYTHING IS READ FROM GIT, NOT FROM DISK, and that is the whole point. The
// first version of this check read the migrations directory and would have
// passed while the bug was live: the DailyBar migration was sitting on disk the
// entire time, it had simply never been committed. Reading the working tree
// tests the wrong thing, and it also means a model legitimately in progress -
// with its migration alongside it, both uncommitted - does not trip an alarm it
// has no way to silence.
//
// Deliberately not `prisma migrate diff --exit-code`, which is more rigorous and
// needs a shadow database. A check that only runs where a database happens to
// exist will not run when it matters.

// Run every git command from the repository root. The test's cwd is
// packages/db, so a repo-relative path like "packages/db/prisma/migrations"
// resolves to packages/db/packages/db/... and silently matches nothing - which
// makes the check pass vacuously, exactly the failure mode the second test
// exists to catch.
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function committedSchema(): string {
  return git("show", "HEAD:packages/db/prisma/schema.prisma");
}

function committedMigrationSql(): string {
  const files = git("ls-files", "packages/db/prisma/migrations")
    .split("\n")
    .filter((line) => line.endsWith("migration.sql"));
  return files.map((file) => git("show", `HEAD:${file}`)).join("\n");
}

test("every model in the committed schema has a committed migration", () => {
  const models = [...committedSchema().matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  const sql = committedMigrationSql();

  const created = new Set<string>();
  // MySQL quotes identifiers with backticks; both the plain and IF NOT EXISTS
  // forms appear across this history.
  for (const match of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?/gi)) {
    created.add(match[1]);
  }
  // A table renamed rather than created is still accounted for.
  for (const match of sql.matchAll(/ALTER TABLE\s+`?(\w+)`?\s+RENAME TO\s+`?(\w+)`?/gi)) {
    created.add(match[2]);
  }

  assert.ok(models.length > 20, `expected the full schema, found ${models.length} models`);
  assert.ok(created.size > 20, `expected many created tables, found ${created.size}`);

  const orphans = models.filter((model) => !created.has(model));
  assert.deepEqual(
    orphans,
    [],
    orphans.length
      ? `Committed models with no committed migration - production will not have these tables:\n` +
        orphans.map((m) => `  - ${m}`).join("\n") +
        `\n\nUsually a whole-file 'git add packages/db/prisma/schema.prisma' sweeping in work\n` +
        `in progress whose migration is still untracked. Either commit the migration\n` +
        `alongside the model, or take the model back out of the commit.`
      : ""
  );
});

test("the check detects an orphan rather than passing vacuously", () => {
  // A guard that cannot fail is decoration. This exercises the same matching on
  // a model that provably has no migration anywhere.
  const sql = committedMigrationSql();
  const created = new Set(
    [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?/gi)].map((m) => m[1])
  );
  assert.equal(created.has("ATableNoMigrationEverCreated"), false);
  assert.equal(created.has("LiveOrder"), true, "sanity: a real table must be found");
});
