/**
 * Snapshot builder — step 3 of Phase 0 (see docs/phase-0-foundations.md).
 *
 * Pulls a small, curated set of real fixtures from PSK's public API,
 * normalizes them into the Fixture/Market schema in types.ts, and writes
 * dist/fixtures.json + dist/markets.json + dist/meta.json.
 *
 * Curated tournaments, not "everything": translating sport/tournament names
 * to English is a manual table below (KNOWN_TRANSLATIONS), which only stays
 * honest at small scale. That is why this script asks for a short, explicit
 * list of tournaments rather than crawling PSK's full catalog.
 *
 * The one deliberate exception to "all real data": PSK's live cricket offer
 * has no India vs Australia fixture (confirmed by querying every cricket
 * tournament during Phase 0 — see docs/phase-0-foundations.md). Since that
 * is the plan's own headline demo example, this script hand-authors one
 * fixture matching the real schema and real market shape, tagged
 * `isSynthetic: true`. Every other fixture below is unmodified PSK data.
 *
 * Operational note: this script does not try to keep old data "fresh" —
 * real fixtures get their genuine PSK kickoff times. Rerun
 * `npm run snapshot` shortly before the demo so those times are naturally
 * near-term. See demoClock.ts for what "demo clock" does and does not do.
 *
 * Usage:
 *   npx tsx src/buildFixtures.ts
 * Dev iteration (faster than the default 20s/request pace):
 *   PSK_FETCH_DELAY_MS=1500 npx tsx src/buildFixtures.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import {
  PskClient,
  type PskFixture,
  type PskMarket,
  type PskScoreboard,
} from "./fetchPsk.ts";
import { captureDemoNow, offsetFromDemoNow, selectNearTerm, HOUR_MS } from "./demoClock.ts";
import type { Fixture, Market, SnapshotMeta } from "./types.ts";

// ---------------------------------------------------------------------------
// Curated source list — deliberately small (see file header).
// ---------------------------------------------------------------------------

const FOOTBALL_SPORT_ID = "ufo:sprt:00";
const CHAMPIONS_LEAGUE_TOURNAMENT_ID = "ufo:tour:00-0fy"; // real "Liga prvaka", confirmed in Phase 0 recon
const CRICKET_SPORT_SEO_NAME = "kriket";

/** Cap per tournament so a full-pace (20s/request) run stays on the order of minutes, not hours. */
const MAX_FIXTURES_PER_TOURNAMENT = 6;
const UPCOMING_WINDOW_DAYS = 30;

/**
 * Small, honest, hand-maintained translation table. Only covers names we
 * have actually seen in the curated tournaments above — an unknown name
 * falls back to the Croatian original rather than a guessed translation.
 */
const KNOWN_TRANSLATIONS: Record<string, string> = {
  // sports
  Nogomet: "Football",
  Kriket: "Cricket",
  // tournaments
  "Liga prvaka": "Champions League",
  "T20 Asia Cup (ž)": "Women's T20 Asia Cup",
  "Prijateljske utakmice - Test Series": "Test Series (Friendly)",
  "Zap. Indija - Caribbean Premier League": "Caribbean Premier League",
  // country-based participant names (club names are proper nouns and need no translation)
  Bangladeš: "Bangladesh",
  Engleska: "England",
  "Zap. Indija": "West Indies",
};

function translate(name: string): string | undefined {
  return KNOWN_TRANSLATIONS[name];
}

// ---------------------------------------------------------------------------
// Normalization: raw PSK shapes -> our schema (types.ts)
// ---------------------------------------------------------------------------

function deriveStatusAndScore(
  scoreboard: PskScoreboard | null,
): Pick<Fixture, "status" | "liveScore"> {
  if (!scoreboard) {
    // No scoreboard yet is treated as "has not started reporting" for a
    // freshly-fetched, near-term fixture. This is a simplification: the
    // generic scoreboard shape has no reliable single "match finished"
    // field across sports, so we do not attempt LIVE vs FINISHED beyond
    // "a scoreboard exists at all". Good enough for a demo snapshot; would
    // need per-sport handling for a general-purpose integration.
    return { status: "SCHEDULED" };
  }
  const home = scoreboard.summaryScoreboards?.Home?.score;
  const away = scoreboard.summaryScoreboards?.Away?.score;
  if (typeof home !== "number" || typeof away !== "number") {
    return { status: "SCHEDULED" };
  }
  return {
    status: "LIVE",
    liveScore: { home, away, gameTime: scoreboard.overview?.gameTime },
  };
}

function normalizeMarket(pskMarket: PskMarket): Market {
  return {
    id: pskMarket.id,
    fixtureId: pskMarket.fixtureId,
    marketTypeId: pskMarket.marketTypeId,
    // PSK's raw marketTypeName occasionally carries a trailing space (e.g.
    // "Tim 1 zbroj golova "). Trim at the source so every downstream exact
    // match (the lexicon join, in particular) never has to think about it.
    marketTypeNameHr: pskMarket.marketTypeName.trim(),
    outcomes: pskMarket.outcomes.map((o) => ({
      id: o.id,
      // Same trailing-space quirk as marketTypeName, seen on compound
      // outcomes like "Da/manje 2.5 " — trim at the source.
      name: o.name.trim(),
      odds: o.odds,
      ...(o.previousOdds !== undefined ? { previousOdds: o.previousOdds } : {}),
    })),
  };
}

function normalizeFixture(
  pskFixture: PskFixture,
  sportNameHr: string,
  tournamentNameHr: string,
  markets: Market[],
  scoreboard: PskScoreboard | null,
): Fixture {
  const home = pskFixture.participants.find((p) => p.type === "HOME");
  const away = pskFixture.participants.find((p) => p.type === "AWAY");
  if (!home || !away) {
    throw new Error(`Fixture ${pskFixture.id} is missing a HOME or AWAY participant`);
  }
  return {
    id: pskFixture.id,
    sportId: pskFixture.sportId,
    sportNameEn: translate(sportNameHr) ?? sportNameHr,
    sportNameHr,
    tournamentId: pskFixture.tournamentId,
    tournamentNameEn: translate(tournamentNameHr) ?? tournamentNameHr,
    tournamentNameHr,
    seoName: pskFixture.seoName,
    home: { id: home.id, name: home.name, ...(translate(home.name) ? { nameEn: translate(home.name) } : {}) },
    away: { id: away.id, name: away.name, ...(translate(away.name) ? { nameEn: translate(away.name) } : {}) },
    kickoffUtc: new Date(pskFixture.startDatetime).toISOString(),
    marketIds: markets.map((m) => m.id),
    isSynthetic: false,
    ...deriveStatusAndScore(scoreboard),
  };
}

// ---------------------------------------------------------------------------
// The one synthetic fixture (see file header for why)
// ---------------------------------------------------------------------------

function buildSyntheticIndiaAustraliaFixture(
  demoNow: Date,
  cricketSportId: string,
  cricketSportNameHr: string,
): { fixture: Fixture; markets: Market[] } {
  const fixtureId = "demo:mtch:ind-aus-t20";
  const marketId = "demo:mkt:ind-aus-t20-winner";

  // Reuses the exact real market pattern observed on a live PSK cricket
  // fixture during Phase 0 recon: single "Konačni pobjednik" (match winner)
  // market, outcomes "1" (home) / "2" (away), no draw — correct for
  // cricket, where PSK carries no 1X2-style market.
  const market: Market = {
    id: marketId,
    fixtureId,
    marketTypeId: "demo:mtyp:konacni-pobjednik",
    marketTypeNameHr: "Konačni pobjednik",
    outcomes: [
      { id: `${marketId}-00`, name: "1", odds: 2.05 },
      { id: `${marketId}-01`, name: "2", odds: 1.72 },
    ],
  };

  const fixture: Fixture = {
    id: fixtureId,
    sportId: cricketSportId,
    sportNameEn: translate(cricketSportNameHr) ?? "Cricket",
    sportNameHr: cricketSportNameHr,
    tournamentId: "demo:tour:ind-aus-t20-series",
    tournamentNameEn: "International T20",
    tournamentNameHr: "Međunarodni T20",
    seoName: "indija-australija-t20",
    home: { id: "demo:team:india", name: "India", nameEn: "India" },
    away: { id: "demo:team:australia", name: "Australia", nameEn: "Australia" },
    // Kicked off 2h before build time: mid-second-innings by demo time,
    // whenever the snapshot is (re)built.
    kickoffUtc: offsetFromDemoNow(demoNow, -2 * HOUR_MS),
    status: "LIVE",
    liveScore: { home: 134, away: 178, gameTime: "Innings 2, 15.2 overs (chasing 179)" },
    marketIds: [marketId],
    isSynthetic: true,
  };

  return { fixture, markets: [market] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchAndNormalizeTournament(
  client: PskClient,
  tournamentId: string,
  sportNameHrOverride: string | undefined,
  demoNow: Date,
  log: (msg: string) => void,
): Promise<{ fixtures: Fixture[]; markets: Market[] }> {
  const { tournament, fixtures: rawFixtures } = await client.getTournamentMatches(tournamentId);
  log(`  tournament "${tournament.name}": ${rawFixtures.length} fixtures total`);

  const withKickoff = rawFixtures.map((f) => ({ ...f, kickoffMs: f.startDatetime }));
  const selected = selectNearTerm(withKickoff, demoNow, UPCOMING_WINDOW_DAYS).slice(
    0,
    MAX_FIXTURES_PER_TOURNAMENT,
  );
  log(`  selected ${selected.length} near-term fixtures (window ${UPCOMING_WINDOW_DAYS}d, cap ${MAX_FIXTURES_PER_TOURNAMENT})`);

  const fixtures: Fixture[] = [];
  const markets: Market[] = [];

  for (const raw of selected) {
    log(`  fetching markets + scoreboard for "${raw.name}"`);
    const [rawMarkets, scoreboard] = await Promise.all([
      client.getFixtureMarkets(raw.id),
      client.getFixtureScoreboard(raw.id),
    ]);
    // A single popular fixture can carry 1000+ granular player-prop markets
    // in PSK's live offer — far more than a voice-search demo needs. PSK's
    // own `overview` flag marks the headline markets (1X2, over/under, BTTS,
    // half-time, etc.) it surfaces first in its own UI; keep only those.
    // Fall back to the unfiltered set on the rare fixture where nothing is
    // flagged, so a fixture is never left with zero markets.
    const overviewOnly = rawMarkets.filter((m) => m.overview === true);
    const curatedRawMarkets = overviewOnly.length > 0 ? overviewOnly : rawMarkets;
    log(`    ${rawMarkets.length} markets -> ${curatedRawMarkets.length} after overview filter`);
    const normalizedMarkets = curatedRawMarkets.map(normalizeMarket);
    markets.push(...normalizedMarkets);
    fixtures.push(
      normalizeFixture(
        raw,
        sportNameHrOverride ?? raw.sportSeoName,
        tournament.name,
        normalizedMarkets,
        scoreboard,
      ),
    );
  }

  return { fixtures, markets };
}

async function main() {
  const demoNow = captureDemoNow();
  const delayMs = process.env.PSK_FETCH_DELAY_MS
    ? Number(process.env.PSK_FETCH_DELAY_MS)
    : undefined; // undefined -> PskClient's own default (20s, honors robots.txt)

  const log = (msg: string) => console.error(msg);
  const client = new PskClient({
    ...(delayMs !== undefined ? { minDelayMs: delayMs } : {}),
    onRequest: (url) => log(`-> ${url}`),
  });

  log(`Snapshot build started at ${demoNow.toISOString()}`);

  const allFixtures: Fixture[] = [];
  const allMarkets: Market[] = [];
  const sourceTournaments: string[] = [];

  // --- Football: Champions League ---
  log("Football / Champions League:");
  const cl = await fetchAndNormalizeTournament(
    client,
    CHAMPIONS_LEAGUE_TOURNAMENT_ID,
    "Nogomet",
    demoNow,
    log,
  );
  allFixtures.push(...cl.fixtures);
  allMarkets.push(...cl.markets);
  sourceTournaments.push(CHAMPIONS_LEAGUE_TOURNAMENT_ID);

  // --- Cricket: every currently-offered tournament (small set) ---
  log("Cricket:");
  const sports = await client.getSports();
  const cricketSport = sports.find((s) => s.seoName === CRICKET_SPORT_SEO_NAME);
  if (!cricketSport) {
    throw new Error(`Cricket sport not found via seoName "${CRICKET_SPORT_SEO_NAME}" — PSK's catalog may have changed.`);
  }
  const { tournaments: cricketTournaments } = await client.getTournamentsForSport(cricketSport.id);

  let foundRealIndiaAustralia = false;
  for (const t of cricketTournaments) {
    const result = await fetchAndNormalizeTournament(client, t.id, cricketSport.name, demoNow, log);
    allFixtures.push(...result.fixtures);
    allMarkets.push(...result.markets);
    sourceTournaments.push(t.id);
    for (const f of result.fixtures) {
      const names = `${f.home.name} ${f.away.name}`.toLowerCase();
      if (/india|indija/.test(names) && /australia|australija/.test(names)) {
        foundRealIndiaAustralia = true;
      }
    }
  }

  // --- Synthetic fallback, only if real data genuinely lacks the fixture ---
  if (foundRealIndiaAustralia) {
    log("Real India vs Australia cricket fixture found — skipping synthetic fixture.");
  } else {
    log("No real India vs Australia cricket fixture in PSK's current offer — authoring the synthetic one.");
    const synthetic = buildSyntheticIndiaAustraliaFixture(demoNow, cricketSport.id, cricketSport.name);
    allFixtures.push(synthetic.fixture);
    allMarkets.push(...synthetic.markets);
  }

  allFixtures.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));

  const meta: SnapshotMeta = {
    builtAt: new Date().toISOString(),
    demoNowUtc: demoNow.toISOString(),
    sourceTournaments,
  };

  await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
  await writeJson("fixtures.json", allFixtures);
  await writeJson("markets.json", allMarkets);
  await writeJson("meta.json", meta);

  const syntheticCount = allFixtures.filter((f) => f.isSynthetic).length;
  log(
    `Done. ${allFixtures.length} fixtures (${syntheticCount} synthetic), ${allMarkets.length} markets written to dist/.`,
  );
}

async function writeJson(filename: string, data: unknown): Promise<void> {
  const url = new URL(`../dist/${filename}`, import.meta.url);
  await writeFile(url, JSON.stringify(data, null, 2) + "\n", "utf8");
}

await main();
