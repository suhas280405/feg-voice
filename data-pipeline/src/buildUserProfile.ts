/**
 * User profile builder — step 5 of Phase 0 (see docs/phase-0-foundations.md).
 *
 * Streams SB_Player.csv (~500MB, ~3M rows) and writes dist/userProfile.json:
 * a single, small, synthetic-composite profile — NOT one real player's
 * history. That is a deliberate choice, not a shortcut:
 *
 *   - The hackathon brief requires anonymised/sample data only. PlayerID
 *     values in the source CSVs are already hashed, but shipping one
 *     specific (even hashed) individual's full betting history as "the
 *     demo user" is a worse privacy posture than an aggregate ever is.
 *   - This script only ever computes AGGREGATE statistics (most frequent
 *     team names, most frequent competitions, a distribution-derived stake
 *     limit) across all rows. No single row's data reaches the output.
 *
 * Only SB_Player.csv is read. It alone carries team names (via
 * fixture_name_english), competitions (event_name_english) and stake
 * amounts at bet-level granularity — enough for a useful profile without
 * also parsing the other ~2GB of provided CSVs (CA_Player, SB_MOM, CA_MOM,
 * event logs, EPS_Offers), which Phase 0 does not need.
 *
 * openTickets is NOT derived from the CSV at all — a CSV row references a
 * real historical PSK fixture that has no relationship to our curated
 * dist/fixtures.json. Instead it is synthesized against our OWN snapshot
 * (built by buildFixtures.ts — run that first) so Phase 3's get_my_activity
 * tool can resolve it against real, present fixture/market/outcome data.
 *
 * Simplifying assumption: SB_Player.csv rows contain no embedded newlines
 * inside quoted fields (reasonable for fixture/market/selection names) —
 * this script reads it line-by-line rather than as a full RFC4180 stream.
 *
 * Usage:
 *   npx tsx src/buildFixtures.ts        (first, produces dist/fixtures.json)
 *   npx tsx src/buildUserProfile.ts
 * Dev iteration (partial scan instead of all ~3M rows):
 *   USER_PROFILE_MAX_ROWS=200000 npx tsx src/buildUserProfile.ts
 */

import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Fixture, Market, OpenTicket, UserProfile } from "./types.ts";

const SOURCE_CSV = new URL("../../SB_Player.csv", import.meta.url);
const TOP_N = 5;

/** RFC4180-ish row splitter: handles quoted fields with embedded commas and escaped quotes. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Streaming mean/variance (Welford's online algorithm) — O(1) memory regardless of row count. */
class RunningStats {
  private n = 0;
  private mean = 0;
  private m2 = 0;

  add(x: number): void {
    this.n++;
    const delta = x - this.mean;
    this.mean += delta / this.n;
    const delta2 = x - this.mean;
    this.m2 += delta * delta2;
  }

  get count(): number {
    return this.n;
  }
  get average(): number {
    return this.mean;
  }
  get stddev(): number {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
  }
}

function topN(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);
}

async function scanSbPlayer(maxRows: number | undefined, log: (msg: string) => void) {
  const teamCounts = new Map<string, number>();
  const tournamentCounts = new Map<string, number>();
  const stakeStats = new RunningStats();

  const rl = createInterface({ input: createReadStream(SOURCE_CSV), crlfDelay: Infinity });

  let rowIndex = -1; // -1 = header row
  let header: string[] = [];
  let iFixture = -1;
  let iEvent = -1;
  let iStake = -1;

  for await (const line of rl) {
    rowIndex++;
    if (rowIndex === 0) {
      header = splitCsvLine(line);
      iFixture = header.indexOf("fixture_name_english");
      iEvent = header.indexOf("event_name_english");
      iStake = header.indexOf("stake_distribution_amount_local");
      if (iFixture === -1 || iEvent === -1 || iStake === -1) {
        throw new Error(
          `SB_Player.csv header is missing an expected column. Found: ${header.join(", ")}`,
        );
      }
      continue;
    }
    if (!line) continue;
    if (maxRows !== undefined && rowIndex > maxRows) break;

    const fields = splitCsvLine(line);

    const fixtureName = fields[iFixture];
    if (fixtureName) {
      const parts = fixtureName.split(" - ").map((p) => p.trim());
      if (parts.length === 2 && parts[0] && parts[1]) {
        teamCounts.set(parts[0], (teamCounts.get(parts[0]) ?? 0) + 1);
        teamCounts.set(parts[1], (teamCounts.get(parts[1]) ?? 0) + 1);
      }
    }

    const eventName = fields[iEvent];
    if (eventName) {
      tournamentCounts.set(eventName, (tournamentCounts.get(eventName) ?? 0) + 1);
    }

    const stake = Number.parseFloat(fields[iStake] ?? "");
    if (Number.isFinite(stake) && stake > 0) {
      stakeStats.add(stake);
    }

    if (rowIndex % 500_000 === 0) {
      log(`  ...${rowIndex.toLocaleString()} rows scanned`);
    }
  }

  log(`  finished: ${rowIndex.toLocaleString()} rows scanned`);
  return { teamCounts, tournamentCounts, stakeStats };
}

/**
 * One plausible open ticket, built from OUR OWN curated snapshot (not the
 * CSV) so it references a fixture/market/outcome that actually exists in
 * dist/fixtures.json. Picks the first real, non-synthetic LIVE fixture with
 * a 1X2-shaped market — currently a Champions League match.
 */
async function synthesizeOpenTicket(sessionStakeLimit: number): Promise<OpenTicket[]> {
  const fixturesUrl = new URL("../dist/fixtures.json", import.meta.url);
  const marketsUrl = new URL("../dist/markets.json", import.meta.url);
  const fixtures: Fixture[] = JSON.parse(await readFile(fixturesUrl, "utf8"));
  const markets: Market[] = JSON.parse(await readFile(marketsUrl, "utf8"));

  const candidate = fixtures.find((f) => !f.isSynthetic && f.status === "LIVE");
  if (!candidate) {
    console.error("  no suitable real fixture found for a sample open ticket — leaving openTickets empty.");
    return [];
  }
  const market = markets.find(
    (m) => m.fixtureId === candidate.id && m.marketTypeNameHr === "Osnovna ponuda",
  );
  const outcome = market?.outcomes.find((o) => o.name === "1"); // back the home side
  if (!market || !outcome) {
    console.error(`  fixture ${candidate.id} has no Osnovna ponuda/"1" outcome — leaving openTickets empty.`);
    return [];
  }

  const stake = Math.max(5, Math.round(sessionStakeLimit * 0.2)); // a modest fraction of the limit
  return [
    {
      id: "demo:ticket:sample-open-1",
      fixtureId: candidate.id,
      market: market.marketTypeNameHr,
      stake,
      potentialReturn: Math.round(stake * outcome.odds * 100) / 100,
    },
  ];
}

async function main() {
  const log = (msg: string) => console.error(msg);
  const maxRows = process.env.USER_PROFILE_MAX_ROWS
    ? Number(process.env.USER_PROFILE_MAX_ROWS)
    : undefined;

  log(`Scanning SB_Player.csv${maxRows ? ` (capped at ${maxRows.toLocaleString()} rows)` : " (full file)"}...`);
  const { teamCounts, tournamentCounts, stakeStats } = await scanSbPlayer(maxRows, log);

  const favouriteTeams = topN(teamCounts, TOP_N);
  const followedTournaments = topN(tournamentCounts, TOP_N);

  // mean + 2*stddev, clamped to a plausible demo range, rounded to the
  // nearest 5 EUR — a distribution-derived limit rather than a made-up one.
  const rawLimit = stakeStats.average + 2 * stakeStats.stddev;
  const sessionStakeLimit = Math.min(500, Math.max(20, Math.round(rawLimit / 5) * 5));

  log(
    `Stake stats: n=${stakeStats.count.toLocaleString()}, mean=${stakeStats.average.toFixed(2)}, stddev=${stakeStats.stddev.toFixed(2)} -> sessionStakeLimit=${sessionStakeLimit}`,
  );
  log(`Top teams: ${favouriteTeams.join(", ")}`);
  log(`Top tournaments: ${followedTournaments.join(", ")}`);

  // Demo-only wallet balance (see UserProfile.walletBalance in types.ts for
  // why this is never real money): a round multiple of the same
  // distribution-derived stake limit, comfortably enough to afford several
  // demo bets without being an implausibly large number.
  const walletBalance = { amount: Math.round((sessionStakeLimit * 8) / 10) * 10, currency: "EUR" as const };
  log(`Wallet balance (demo only): ${walletBalance.amount} ${walletBalance.currency}`);

  log("Synthesizing an open ticket against dist/fixtures.json...");
  const openTickets = await synthesizeOpenTicket(sessionStakeLimit);

  const profile: UserProfile = {
    userId: "demo-user-aggregate-01",
    favouriteTeams,
    followedTournaments,
    openTickets,
    walletBalance,
    limits: { sessionStakeLimit, currency: "EUR" },
  };

  const outUrl = new URL("../dist/userProfile.json", import.meta.url);
  await writeFile(outUrl, JSON.stringify(profile, null, 2) + "\n", "utf8");
  log("Done. Written to dist/userProfile.json.");
}

await main();
