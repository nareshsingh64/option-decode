/**
 * Backfills NSE INDEX daily OHLC into DailyBar, alongside the equity bars.
 *
 * Why: the stocks backtest needs a "market bias" - is the broad market
 * bullish or bearish on this date - and there was no market series in the
 * app. The repo's own calculateMarketBias is option-chain derived and stock
 * chains hold a single day, so it cannot answer this over 646 trading days.
 * The index's own trend can.
 *
 * Rows land in DailyBar with series = 'IDX', which keeps them OUT of the
 * tradeable stock universe (loadDailyBars filters on series) while reusing the
 * same table, adjustment path and indicator code.
 *
 * A different archive from the equity bhavcopy - one CSV per day covering
 * every NSE index:
 *   https://nsearchives.nseindia.com/content/indices/ind_close_all_<DDMMYYYY>.csv
 * Verified back to 2024-01-02. Same browser-header requirement as the equity
 * archive, and the same 200-with-an-HTML-error-page failure mode.
 *
 * THE FETCH LIST COMES FROM DailyBar, NOT A CALENDAR. We already know exactly
 * which 646 dates traded, because the equity ingest established them. Asking
 * only for those dates means zero wasted requests - which matters, because
 * probing every calendar day is what got the equity backfill rate-limited to
 * 403 on everything.
 *
 * Usage:
 *   pnpm --filter @option-decode/api exec dotenv -e ../../.env.local -- \
 *     tsx src/scripts/ingest-nse-index-bhavcopy.ts [--force]
 *
 * WRITES to DailyBar (series 'IDX'). Read-only against everything else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARCHIVE_BASE = "https://nsearchives.nseindia.com/content/indices";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/"
};
const CACHE_DIR = join(tmpdir(), "nse-index-cache");

/** Indices worth storing. "Nifty 50" is the market-bias series; the other two
 * are cheap to carry and useful for sector/breadth work later. */
const WANTED = ["Nifty 50", "Nifty Bank", "Nifty 500"];

function mysqlAttachSpec(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set - run this through dotenv -e ../../.env.local");
  const parsed = new URL(url);
  return [
    `host=${parsed.hostname}`,
    `port=${parsed.port || "3306"}`,
    `user=${decodeURIComponent(parsed.username)}`,
    `password=${decodeURIComponent(parsed.password)}`,
    `database=${parsed.pathname.replace(/^\//, "")}`
  ].join(" ");
}

function runDuckDb(dbPath: string, sql: string): string {
  return execFileSync("duckdb", [dbPath, "-csv", "-noheader"], { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FetchResult = { date: string; status: "ok" | "missing" | "throttled" | "failed"; path?: string; error?: string };

/** date is ISO; the archive wants DDMMYYYY. */
async function fetchOne(date: string): Promise<FetchResult> {
  const [y, m, d] = date.split("-");
  const compact = `${d}${m}${y}`;
  const path = join(CACHE_DIR, `ind_close_all_${compact}.csv`);
  if (existsSync(path)) return { date, status: "ok", path };

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${ARCHIVE_BASE}/ind_close_all_${compact}.csv`, { headers: HEADERS });
      if (res.status === 404) return { date, status: "missing" };
      // 403 is rate limiting, never a missing day - same rule as the equity
      // ingest. Recording it as missing would bake a permanent hole in.
      if (res.status === 403 || res.status === 429) {
        if (attempt === 4) return { date, status: "throttled", error: `HTTP ${res.status}` };
        await sleep(Number(res.headers.get("retry-after") ?? 0) * 1000 || 5_000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // The archive serves an HTML error page with a 200 when it dislikes the
      // request, so check for the real header rather than trusting the status.
      if (!text.startsWith("Index Name")) throw new Error("response was not the index CSV");
      writeFileSync(path, text);
      return { date, status: "ok", path };
    } catch (err) {
      if (attempt === 4) return { date, status: "failed", error: err instanceof Error ? err.message : String(err) };
      await sleep(1_000 * attempt);
    }
  }
  return { date, status: "failed", error: "unreachable" };
}

async function fetchAll(dates: string[], concurrency: number, onProgress: (done: number, total: number) => void): Promise<FetchResult[]> {
  const results: FetchResult[] = [];
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < dates.length) {
      const date = dates[cursor++];
      results.push(await fetchOne(date));
      onProgress(++done, dates.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, dates.length) }, worker));
  return results;
}

async function main() {
  const force = process.argv.includes("--force");
  mkdirSync(CACHE_DIR, { recursive: true });
  const workDir = join(tmpdir(), `index-ingest-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const dbPath = join(workDir, "ingest.duckdb");
  const attach = mysqlAttachSpec();

  try {
    // The trading calendar is whatever the equity bars established - no
    // guessing, and no probing of days that never traded.
    const calendarCsv = runDuckDb(
      dbPath,
      `INSTALL mysql; LOAD mysql;
       ATTACH '${attach}' AS m (TYPE mysql, READ_ONLY);
       SELECT DISTINCT strftime(date, '%Y-%m-%d') FROM m.DailyBar WHERE series <> 'IDX' ORDER BY 1;`
    ).trim();
    const tradingDays = calendarCsv ? calendarCsv.split("\n") : [];

    const haveCsv = runDuckDb(
      dbPath,
      `INSTALL mysql; LOAD mysql;
       ATTACH '${attach}' AS m (TYPE mysql, READ_ONLY);
       SELECT DISTINCT strftime(date, '%Y-%m-%d') FROM m.DailyBar WHERE series = 'IDX';`
    ).trim();
    const have = new Set(haveCsv ? haveCsv.split("\n") : []);

    const pending = force ? tradingDays : tradingDays.filter((d) => !have.has(d));
    console.log(`NSE index bhavcopy -> DailyBar (series 'IDX')`);
    console.log(`Indices: ${WANTED.join(", ")}`);
    console.log(`\n${tradingDays.length} trading days known from the equity bars, ${have.size} already ingested, ${pending.length} to fetch.\n`);
    if (pending.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    let lastLogged = 0;
    const results = await fetchAll(pending, 3, (done, total) => {
      if (done === total || done - lastLogged >= 50) {
        lastLogged = done;
        process.stdout.write(`  fetched ${done}/${total}\r`);
      }
    });
    const files = results.filter((r) => r.path).map((r) => r.path!);
    const throttled = results.filter((r) => r.status === "throttled");
    const failed = results.filter((r) => r.status === "failed");
    const missing = results.filter((r) => r.status === "missing");
    console.log(`\n  ok ${files.length}, missing ${missing.length}, throttled ${throttled.length}, failed ${failed.length}`);
    for (const f of failed.slice(0, 10)) console.log(`    FAILED ${f.date}: ${f.error}`);
    if (throttled.length > 0) console.log(`  ${throttled.length} date(s) rate-limited and left UNKNOWN - re-run to resolve.`);
    if (files.length === 0) return;

    const fileList = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
    const wanted = WANTED.map((w) => `'${w}'`).join(", ");
    const loadSql = `
      INSTALL mysql; LOAD mysql;
      ATTACH '${attach}' AS m (TYPE mysql);

      CREATE OR REPLACE TABLE staged AS
        SELECT
          upper("Index Name")                                  AS symbol,
          strptime("Index Date", '%d-%m-%Y')::DATE              AS date,
          CAST("Open Index Value"    AS DECIMAL(14,2))          AS open,
          CAST("High Index Value"    AS DECIMAL(14,2))          AS high,
          CAST("Low Index Value"     AS DECIMAL(14,2))          AS low,
          CAST("Closing Index Value" AS DECIMAL(14,2))          AS close,
          -- Volume is blank for several indices; DailyBar.volume is NOT NULL
          -- and zero is the honest value for "not reported".
          CAST(coalesce(TRY_CAST("Volume" AS DOUBLE), 0) AS BIGINT) AS volume,
          CAST(TRY_CAST("Turnover (Rs. Cr.)" AS DOUBLE) * 10000000 AS DECIMAL(20,2)) AS turnover
        FROM read_csv([${fileList}], delim = ',', header = true, all_varchar = true,
                      null_padding = true, union_by_name = true, filename = false)
        WHERE "Index Name" IN (${wanted})
          AND TRY_CAST("Closing Index Value" AS DOUBLE) IS NOT NULL
        QUALIFY row_number() OVER (PARTITION BY upper("Index Name"), strptime("Index Date", '%d-%m-%Y')::DATE ORDER BY 1) = 1;

      ${force ? `DELETE FROM m.DailyBar WHERE series = 'IDX' AND date IN (SELECT DISTINCT date FROM staged);` : ""}

      INSERT INTO m.DailyBar (symbol, date, open, high, low, close, prevClose, volume, trades, turnover, series, source, createdAt)
      SELECT symbol, date, open, high, low, close,
             -- The index file carries no previous close. NULL rather than a
             -- derived value: the missing-session detector keys off this
             -- column and must not be fed something invented.
             NULL, volume, NULL, turnover, 'IDX', 'NSE_INDEX', now()
      FROM staged
      WHERE NOT EXISTS (SELECT 1 FROM m.DailyBar d WHERE d.symbol = staged.symbol AND d.date = staged.date);

      SELECT (SELECT count(*) FROM staged), (SELECT count(DISTINCT symbol) FROM staged), (SELECT count(DISTINCT date) FROM staged);
    `;
    const summary = runDuckDb(dbPath, loadSql).trim().split("\n").at(-1) ?? "";
    const [rows, syms, days] = summary.split(",");
    console.log(`\nStaged ${rows} rows across ${syms} indices and ${days} trading days.`);

    if (Number(days) !== files.length) {
      console.log(`  WARNING: ${files.length} files but only ${days} days staged - inspect before trusting the table.`);
    }

    const state = runDuckDb(
      dbPath,
      `INSTALL mysql; LOAD mysql;
       ATTACH '${attach}' AS m (TYPE mysql, READ_ONLY);
       SELECT symbol, count(*), strftime(min(date), '%Y-%m-%d'), strftime(max(date), '%Y-%m-%d')
       FROM m.DailyBar WHERE series = 'IDX' GROUP BY symbol ORDER BY symbol;`
    ).trim();
    console.log("\nDailyBar index rows now:");
    for (const line of state ? state.split("\n") : []) {
      const [symbol, n, first, last] = line.split(",");
      console.log(`  ${symbol.padEnd(14)} ${String(n).padStart(5)} bars   ${first} .. ${last}`);
    }
    console.log(`\nCache: ${CACHE_DIR} (${readdirSync(CACHE_DIR).length} files).`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
