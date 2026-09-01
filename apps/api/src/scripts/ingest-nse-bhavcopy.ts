/**
 * Backfills DailyBar from the NSE UDiFF bhavcopy archive.
 *
 * This is the only source of REAL daily OHLC in this app. Everything else is
 * synthesized from 1-minute LTP ticks, which cannot express a true daily
 * high/low and reaches back only as far as capture has been running (nine
 * days, at the time of writing). The daily regime filter in
 * docs/high-winrate-fno-strategy-plan.md needs ~50 daily bars for an EMA50 and
 * ADX(14); bhavcopy is free, public and retroactive, so one backfill gets
 * years at once rather than waiting a quarter for capture to accumulate.
 *
 * FORMAT NOTE. NSE retired the legacy `cm<DD><MON><YYYY>bhav.csv.zip` layout
 * in 2024 - it now 404s. The current one is UDiFF:
 *   https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_<YYYYMMDD>_F_0000.csv.zip
 * Verified available back to 2026-01-02 at least; 2023 dates 404. Requests
 * need a browser User-Agent and an nseindia.com Referer or the archive host
 * returns an HTML error page instead of the zip.
 *
 * IDEMPOTENT by construction: DailyBar's primary key is (symbol, date), and
 * this only downloads dates that have no rows yet. Re-run it freely. Dates
 * that 404 are trading holidays and are reported, not retried within a run.
 *
 * Parsing, filtering and the MySQL insert all happen inside DuckDB - the CSVs
 * never become JS values. Same reasoning as the divergence backtest loader:
 * ~2,400 equity rows/day over hundreds of days is enough to matter, and the
 * Prisma path has already been OOM-killed once on this scale of row count.
 *
 * Usage:
 *   pnpm --filter @option-decode/api exec dotenv -e ../../.env.local -- \
 *     tsx src/scripts/ingest-nse-bhavcopy.ts --from 2024-01-01 --to 2026-08-07
 *
 * Flags:
 *   --from / --to      inclusive ISO dates (default: last 400 calendar days)
 *   --all-equities     load every EQ/BE scrip, not just the F&O universe
 *   --force            re-ingest dates already present (deletes them first)
 *   --concurrency N    parallel downloads, default 4
 *
 * Downloaded CSVs are cached under $TMPDIR/nse-bhavcopy-cache so a re-run
 * after a failure does not re-download. ~200KB per trading day.
 *
 * WRITES to DailyBar. Reads FnoStock. Touches nothing else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARCHIVE_BASE = "https://nsearchives.nseindia.com/content/cm";
// The archive host rejects non-browser clients with an HTML error page rather
// than a 403, so a wrong UA looks like a corrupt zip rather than a refusal.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/"
};
const CACHE_DIR = join(tmpdir(), "nse-bhavcopy-cache");
/**
 * Dates NSE has confirmed (with a 404) are not trading days.
 *
 * Without this, every re-run re-probes ~300 weekends and holidays across a
 * multi-year range. That burst is what got this script rate-limited to 403 on
 * everything - at which point a 403 is indistinguishable from a holiday
 * unless you already know which dates are settled. Recording them makes
 * re-runs cost only the genuinely unknown dates.
 */
const NON_TRADING_FILE = join(CACHE_DIR, "non-trading-days.json");
/** NSE series worth storing: EQ is normal rolling settlement, BE is
 * trade-to-trade. Everything else in the file is bonds, SME, ETFs and
 * government securities, none of which is in the F&O universe. */
const SERIES = ["EQ", "BE"];

interface Args {
  from: string;
  to: string;
  allEquities: boolean;
  force: boolean;
  concurrency: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 400 * 86_400_000);
  return {
    from: get("--from") ?? defaultFrom.toISOString().slice(0, 10),
    to: get("--to") ?? today.toISOString().slice(0, 10),
    allEquities: argv.includes("--all-equities"),
    force: argv.includes("--force"),
    concurrency: Number(get("--concurrency") ?? 4)
  };
}

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

// SQL goes in on stdin, never argv: the ATTACH string carries the MySQL
// password and argv is world-readable via ps.
function runDuckDb(dbPath: string, sql: string, csv = true): string {
  return execFileSync("duckdb", csv ? [dbPath, "-csv", "-noheader"] : [dbPath], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  });
}

/**
 * EVERY calendar day in [from, to] - deliberately not just weekdays.
 *
 * NSE trades on some weekends. The Union Budget session runs on 1 February
 * whatever day that falls on (2026-02-01 was a Sunday and a full live
 * session), and Diwali Muhurat trading can land on a Saturday too. Filtering
 * to Mon-Fri silently dropped 2026-02-01, which then showed up as a fake 5-9%
 * overnight gap across 54 symbols in the corporate-action detector.
 *
 * Non-trading days simply 404, which costs one cheap request each. Correctness
 * is worth ~270 extra 404s on a multi-year backfill.
 */
function tradingDayCandidates(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

type FetchResult = { date: string; status: "downloaded" | "cached" | "holiday" | "throttled" | "failed"; csvPath?: string; error?: string };

/**
 * A 404 this recent does not mean "not a trading day" - it means the bhavcopy
 * for that date has not been published yet. NSE publishes after the close,
 * typically by ~18:00 IST, so a run during market hours 404s on today.
 *
 * Caching that would be permanent damage: today would be recorded as a holiday
 * and no later run would ever fetch it. Dates inside this window are therefore
 * never persisted, and any that a previous version wrote are dropped on load
 * so an already-poisoned cache heals itself.
 */
const RECENT_UNSETTLED_DAYS = 3;

function unsettledCutoff(): string {
  return new Date(Date.now() - RECENT_UNSETTLED_DAYS * 86_400_000).toISOString().slice(0, 10);
}

function loadNonTradingDays(): Set<string> {
  if (!existsSync(NON_TRADING_FILE)) return new Set();
  try {
    const cutoff = unsettledCutoff();
    return new Set((JSON.parse(readFileSync(NON_TRADING_FILE, "utf8")) as string[]).filter((d) => d < cutoff));
  } catch {
    return new Set();
  }
}

function saveNonTradingDays(days: Set<string>) {
  const cutoff = unsettledCutoff();
  writeFileSync(NON_TRADING_FILE, JSON.stringify([...days].filter((d) => d < cutoff).sort(), null, 0));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(date: string): Promise<FetchResult> {
  const compact = date.replace(/-/g, "");
  const csvPath = join(CACHE_DIR, `BhavCopy_NSE_CM_0_0_0_${compact}_F_0000.csv`);
  if (existsSync(csvPath)) return { date, status: "cached", csvPath };

  const zipPath = join(CACHE_DIR, `${compact}.zip`);
  const url = `${ARCHIVE_BASE}/BhavCopy_NSE_CM_0_0_0_${compact}_F_0000.csv.zip`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      // 404 is the normal signal for a non-trading day - NSE publishes nothing
      // for holidays, so this is expected and gets cached.
      if (res.status === 404) return { date, status: "holiday" };
      // 403 is rate limiting, NOT a holiday. Conflating the two would record
      // real trading days as holidays and bake a hole into the archive that no
      // later run would ever retry. Back off hard and report it as unresolved.
      if (res.status === 403 || res.status === 429) {
        if (attempt === 4) return { date, status: "throttled", error: `HTTP ${res.status} after ${attempt} attempts` };
        await sleep(Number(res.headers.get("retry-after") ?? 0) * 1000 || 5_000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // The archive's HTML error page arrives with a 200, so check the magic.
      if (buf.subarray(0, 2).toString() !== "PK") throw new Error("response was not a zip (archive returned an error page)");
      writeFileSync(zipPath, buf);
      execFileSync("unzip", ["-o", "-q", zipPath, "-d", CACHE_DIR]);
      rmSync(zipPath, { force: true });
      if (!existsSync(csvPath)) return { date, status: "failed", error: "zip did not contain the expected CSV" };
      return { date, status: "downloaded", csvPath };
    } catch (err) {
      if (attempt === 4) return { date, status: "failed", error: err instanceof Error ? err.message : String(err) };
      await sleep(1_000 * attempt);
    }
  }
  return { date, status: "failed", error: "unreachable" };
}

/** Bounded-concurrency pool. NSE's archive host is a public service being
 * asked for hundreds of files; this stays deliberately modest. */
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
  const args = parseArgs();
  mkdirSync(CACHE_DIR, { recursive: true });
  const workDir = join(tmpdir(), `bhavcopy-ingest-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const dbPath = join(workDir, "ingest.duckdb");
  const attach = mysqlAttachSpec();

  console.log(`NSE bhavcopy -> DailyBar   ${args.from} .. ${args.to}`);
  console.log(`Universe: ${args.allEquities ? "all EQ/BE equities" : "F&O stocks only (FnoStock.active)"}${args.force ? "   [--force: existing dates will be replaced]" : ""}`);

  try {
    // --- Which dates already exist? The PK makes re-inserting a no-op only in
    // the sense that it would error; skipping is what makes the run idempotent.
    const existingCsv = runDuckDb(
      dbPath,
      `INSTALL mysql; LOAD mysql;
       ATTACH '${attach}' AS m (TYPE mysql, READ_ONLY);
       SELECT DISTINCT strftime(date, '%Y-%m-%d') FROM m.DailyBar
       WHERE date BETWEEN DATE '${args.from}' AND DATE '${args.to}';`
    ).trim();
    const existing = new Set(existingCsv ? existingCsv.split("\n") : []);

    const candidates = tradingDayCandidates(args.from, args.to);
    const knownNonTrading = loadNonTradingDays();
    const pending = args.force
      ? candidates.filter((d) => !knownNonTrading.has(d))
      : candidates.filter((d) => !existing.has(d) && !knownNonTrading.has(d));
    console.log(
      `\n${candidates.length} calendar days in range, ${existing.size} already ingested, ` +
        `${knownNonTrading.size ? `${[...knownNonTrading].filter((d) => d >= args.from && d <= args.to).length} known non-trading, ` : ""}` +
        `${pending.length} to fetch.\n`
    );
    if (pending.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    // --- Download.
    let lastLogged = 0;
    const results = await fetchAll(pending, args.concurrency, (done, total) => {
      if (done === total || done - lastLogged >= 25) {
        lastLogged = done;
        process.stdout.write(`  fetched ${done}/${total}\r`);
      }
    });
    const csvFiles = results.filter((r) => r.csvPath).map((r) => r.csvPath!);
    const holidays = results.filter((r) => r.status === "holiday");
    const throttled = results.filter((r) => r.status === "throttled");
    const failures = results.filter((r) => r.status === "failed");

    // Only 404s are settled facts. Throttled dates stay unknown so a later run
    // retries them - the whole point of separating the two statuses.
    for (const h of holidays) knownNonTrading.add(h.date);
    saveNonTradingDays(knownNonTrading);

    console.log(
      `\n  downloaded ${results.filter((r) => r.status === "downloaded").length}, ` +
        `from cache ${results.filter((r) => r.status === "cached").length}, ` +
        `holidays (404) ${holidays.length}, throttled (403) ${throttled.length}, failed ${failures.length}`
    );
    for (const f of failures) console.log(`    FAILED ${f.date}: ${f.error}`);
    if (throttled.length > 0) {
      console.log(
        `\n  ${throttled.length} date(s) were rate-limited and remain UNKNOWN - they are not recorded as holidays.\n` +
          `  Re-run later to resolve them: ${throttled.slice(0, 10).map((t) => t.date).join(", ")}${throttled.length > 10 ? ", ..." : ""}`
      );
    }
    if (csvFiles.length === 0) {
      console.log("\nNo files to load.");
      return;
    }

    // --- Parse, filter and insert, entirely inside DuckDB.
    const fileList = csvFiles.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
    const universeJoin = args.allEquities
      ? ""
      : `JOIN (SELECT symbol FROM m.FnoStock WHERE active) f ON f.symbol = b.TckrSymb`;
    const forceDelete = args.force
      ? `DELETE FROM m.DailyBar WHERE date IN (SELECT DISTINCT date FROM staged);`
      : "";

    const loadSql = `
      INSTALL mysql; LOAD mysql;
      ATTACH '${attach}' AS m (TYPE mysql);

      CREATE OR REPLACE TABLE staged AS
        SELECT
          b.TckrSymb                       AS symbol,
          CAST(b.TradDt AS DATE)           AS date,
          CAST(b.OpnPric AS DECIMAL(14,2)) AS open,
          CAST(b.HghPric AS DECIMAL(14,2)) AS high,
          CAST(b.LwPric  AS DECIMAL(14,2)) AS low,
          CAST(b.ClsPric AS DECIMAL(14,2)) AS close,
          CAST(b.PrvsClsgPric AS DECIMAL(14,2)) AS prevClose,
          CAST(b.TtlTradgVol AS BIGINT)    AS volume,
          CAST(b.TtlNbOfTxsExctd AS BIGINT) AS trades,
          CAST(b.TtlTrfVal AS DECIMAL(20,2)) AS turnover,
          b.SctySrs                        AS series
        -- Every parse option is pinned rather than sniffed, because sniffing
        -- silently loses whole files: bhavcopies before ~2024-06-21 carry a
        -- 35-field HEADER against 34-field data rows, which defeats DuckDB's
        -- dialect detection. It then parsed those files as a single unnamed
        -- column, union_by_name contributed nothing, and 120 trading days
        -- vanished with no error and no failed download. null_padding absorbs
        -- the ragged header; all_varchar keeps types identical across 600+
        -- files so one odd file cannot shift a column's inferred type.
        FROM read_csv(
          [${fileList}],
          delim = ',', header = true, all_varchar = true,
          null_padding = true, union_by_name = true, filename = false
        ) b
        ${universeJoin}
        WHERE b.SctySrs IN (${SERIES.map((s) => `'${s}'`).join(", ")})
          AND b.ClsPric IS NOT NULL
        -- A scrip should never appear twice for one date, but the PK would
        -- reject the whole batch if it did. Keep the higher-volume row.
        QUALIFY row_number() OVER (PARTITION BY b.TckrSymb, CAST(b.TradDt AS DATE) ORDER BY b.TtlTradgVol DESC) = 1;

      ${forceDelete}

      INSERT INTO m.DailyBar
        (symbol, date, open, high, low, close, prevClose, volume, trades, turnover, series, source, createdAt)
      SELECT symbol, date, open, high, low, close, prevClose, volume, trades, turnover, series, 'NSE_UDIFF', now()
      FROM staged
      -- Belt and braces: --force deletes first, and without it these dates had
      -- no rows anyway. This makes a partial previous run safe to resume.
      WHERE NOT EXISTS (SELECT 1 FROM m.DailyBar d WHERE d.symbol = staged.symbol AND d.date = staged.date);

      SELECT (SELECT count(*) FROM staged) AS staged_rows,
             (SELECT count(DISTINCT symbol) FROM staged) AS symbols,
             (SELECT count(DISTINCT date) FROM staged) AS trading_days;
    `;
    const summary = runDuckDb(dbPath, loadSql).trim().split("\n").at(-1) ?? "";
    const [stagedRows, symbols, tradingDays] = summary.split(",");

    console.log(`\nStaged ${stagedRows} rows across ${symbols} symbols and ${tradingDays} trading days.`);

    // A file that parses to nothing is the failure mode this ingest is most
    // exposed to, and it is invisible: the download succeeds, no error is
    // raised, and the day is simply absent. Assert every downloaded file
    // contributed a trading day rather than trusting the parse.
    const expectedDays = csvFiles.length;
    if (Number(tradingDays) !== expectedDays) {
      const stagedDates = new Set(
        runDuckDb(dbPath, `SELECT DISTINCT strftime(date, '%Y%m%d') FROM staged;`)
          .trim()
          .split("\n")
          .filter(Boolean)
      );
      const silent = csvFiles.map((p) => p.match(/_(\d{8})_F_0000\.csv$/)?.[1]).filter((d): d is string => !!d && !stagedDates.has(d));
      console.log(`\n  WARNING: ${expectedDays} files downloaded but only ${tradingDays} trading days staged.`);
      if (silent.length > 0) console.log(`  Files that parsed to zero rows: ${silent.slice(0, 20).join(", ")}${silent.length > 20 ? ", ..." : ""}`);
      console.log("  This is a parse problem, not a download problem - inspect those files before trusting the table.");
    }

    // --- Report the resulting table state.
    const state = runDuckDb(
      dbPath,
      `INSTALL mysql; LOAD mysql;
       ATTACH '${attach}' AS m (TYPE mysql, READ_ONLY);
       SELECT count(*), count(DISTINCT symbol), count(DISTINCT date),
              strftime(min(date), '%Y-%m-%d'), strftime(max(date), '%Y-%m-%d')
       FROM m.DailyBar;`
    ).trim();
    const [rows, syms, days, first, last] = state.split(",");
    console.log(`DailyBar now holds ${Number(rows).toLocaleString()} rows · ${syms} symbols · ${days} trading days · ${first} .. ${last}`);

    if (holidays.length > 0) {
      const shown = holidays.slice(0, 12).map((h) => h.date).join(", ");
      console.log(`\nTrading holidays skipped (${holidays.length}): ${shown}${holidays.length > 12 ? ", ..." : ""}`);
    }
    console.log(`\nCache: ${CACHE_DIR} (${readdirSync(CACHE_DIR).length} files). Safe to delete; it only saves re-downloading.`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
