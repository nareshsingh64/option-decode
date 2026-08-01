// Shared by market-repository.ts (tick inserts) and wave-price-repository.ts
// (wave price point inserts) - the two call sites confirmed in production
// (2026-07-31) to be driving the worker process's RSS growth via Prisma's
// per-shape prepared-statement cache. Prisma's native query engine caches a
// compiled statement per distinct SQL shape it sees, and createMany()'s
// generated SQL has a placeholder count proportional to row count - so
// calling it with a different row count every time (as both call sites did,
// since their row counts vary call to call) creates a new, permanently
// cached statement every time.
//
// A first attempt just chunked via Array.slice into groups of a fixed size -
// that does NOT bound the shape count on its own: any call whose total row
// count is under the chunk size still produces a single createMany with
// whatever row count that call happens to have, and even for larger calls
// the trailing remainder chunk is itself variably sized. Verified in
// production: RSS growth slowed (~5-6x) but did not stop.
//
// insertInFixedShapes guarantees every createMany call has a CONSTANT row
// count (exactly chunkSize), and handles the remainder via individual
// single-row create() calls instead of a variably-sized createMany. That
// bounds a call site to exactly 2 distinct SQL shapes forever, regardless of
// how row counts vary.
export async function insertInFixedShapes<T>(
  rows: T[],
  chunkSize: number,
  createMany: (batch: T[]) => Promise<{ count: number }>,
  createOne: (row: T) => Promise<unknown>,
  isIgnorableCreateOneError?: (error: unknown) => boolean
): Promise<number> {
  let count = 0;
  let i = 0;
  for (; i + chunkSize <= rows.length; i += chunkSize) {
    const result = await createMany(rows.slice(i, i + chunkSize));
    count += result.count;
  }
  for (; i < rows.length; i += 1) {
    try {
      await createOne(rows[i]);
      count += 1;
    } catch (error) {
      // createMany's skipDuplicates has no single-row create() equivalent -
      // callers that need to preserve skip-on-duplicate behavior for the
      // remainder pass a predicate identifying the duplicate-key error to
      // swallow instead of throwing.
      if (!isIgnorableCreateOneError || !isIgnorableCreateOneError(error)) {
        throw error;
      }
    }
  }
  return count;
}
