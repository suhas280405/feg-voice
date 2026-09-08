/**
 * Thin, typed client for PSK's public, unauthenticated offer API
 * (base https://api.psk.hr/offer). No auth, no cookies — this is the same
 * API the psk.hr website's Vue micro-frontends call.
 *
 * Every interface below matches field names exactly as PSK returns them,
 * confirmed against live responses during Phase 0 (see docs/phase-0-foundations.md).
 * These are RAW shapes. buildFixtures.ts (step 3) normalizes them into the
 * Fixture/Market types in types.ts — this file does no normalization.
 *
 * Rate limiting: psk.hr's robots.txt declares "Crawl-delay: 20". This client
 * queues every request through a single sequential lane (never concurrent)
 * and defaults to a 20s gap between requests, matching that directive
 * literally. Override via `minDelayMs` in the constructor for local dev
 * iteration — the default is what an actual snapshot run should use.
 */

import { pathToFileURL } from "node:url";

const BASE_URL = "https://api.psk.hr/offer";
const DEFAULT_MIN_DELAY_MS = 20_000; // robots.txt: Crawl-delay: 20
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Raw PSK response shapes
// ---------------------------------------------------------------------------

export interface PskSport {
  id: string;
  name: string;
  seoName: string;
  icon: string;
  type: string;
  order: number;
  fixturesCount: number;
  filters?: string[];
  features?: string[];
}

export interface PskCategory {
  id: string;
  name: string;
  seoName: string;
  icon?: string;
  sportOrder?: number;
  categoryOrder?: number;
  order?: number;
  fixturesCount?: number;
  features?: string[];
}

export interface PskTournament {
  id: string;
  sportId: string;
  categoryId: string;
  name: string;
  sportSeoName: string;
  categorySeoName: string;
  seoName: string;
  description?: string;
  icon?: string;
  sportOrder: number;
  categoryOrder: number;
  order: number;
  fixturesCount: number;
  listUnderSport?: boolean;
  features?: string[];
  filters?: string[];
  sportradarIds?: string[];
}

export interface PskParticipant {
  id: string;
  name: string;
  type: "HOME" | "AWAY";
  icon?: string;
}

/**
 * A fixture as returned by the structure API (sports list widget, tournament
 * matches, live widget). NOTE: "kind" here has been observed as "LIVE" on
 * fixtures that are not currently in progress — treat it as PSK's internal
 * offer classification, not a reliable "is this being played right now"
 * flag. Prefer the scoreboard endpoint (getFixtureScoreboard) to determine
 * actual live state.
 */
export interface PskFixture {
  id: string;
  sportId: string;
  categoryId: string;
  tournamentId: string;
  sportradarIds?: string[];
  kind: string;
  name: string;
  sportSeoName: string;
  categorySeoName: string;
  tournamentSeoName: string;
  seoName: string;
  sportOrder: number;
  categoryOrder: number;
  tournamentOrder: number;
  order: number;
  participants: PskParticipant[];
  /** Epoch milliseconds. */
  startDatetime: number;
  totalMarketCount: number;
  features?: string[];
  marketTypeIds: string[];
  hasMarkets: boolean;
  status: string;
}

export interface PskMarketOutcome {
  id: string;
  marketId: string;
  name: string;
  longName: string;
  odds: number;
  previousOdds?: number;
  order: { rowOrder: number; columnOrder: number };
  displayType: string;
  specifiers?: unknown;
  badges?: string[];
  features?: string[];
  optionTypeId?: string;
}

export interface PskMarket {
  id: string;
  fixtureId: string;
  marketTypeId: string;
  chips?: string[];
  tournamentStageIds?: string[];
  kind: string;
  variant: string;
  specifiers?: unknown;
  /** Match-specific market name, e.g. "Gulin S.: Zbroj gemova 8.5". */
  name: string;
  /** The stable, reusable Croatian market-type name — the lexicon join key. */
  marketTypeName: string;
  marketTypeDesc?: string | null;
  order: number;
  supportGroup?: number;
  supportGroupEx?: number;
  syntheticGroupKey?: string;
  stakeSplit?: boolean;
  orderByFirstOdds?: boolean;
  overview?: boolean;
  outcomes: PskMarketOutcome[];
  features?: string[];
}

export interface PskSportTournaments {
  sport: PskSport;
  categories: PskCategory[];
  tournaments: PskTournament[];
}

export interface PskTournamentMatches {
  tournament: PskTournament;
  fixtures: PskFixture[];
}

export interface PskLiveWidget {
  sports: PskSport[];
  tournaments: PskTournament[];
  fixtures: PskFixture[];
  markets: PskMarket[];
}

/**
 * Scoreboard shape is genuinely sport-dependent (tennis carries sets/serve,
 * football carries cards/corners, etc.) — modeled loosely on purpose rather
 * than over-constrained per-sport unions we have not all observed.
 */
export interface PskScoreboard {
  type: string;
  fixtureId: string;
  scheduledStartTime: number;
  summaryScoreboards: Record<string, { score: number; [key: string]: unknown }>;
  overview?: { gameTime?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type SeoEntityKind = "sport" | "category" | "tournament" | "fixture";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PskApiError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    message: string,
  ) {
    super(`PSK API ${status} on ${url}: ${message}`);
    this.name = "PskApiError";
  }
}

export interface PskClientOptions {
  /** Minimum gap between successive requests. Default honors robots.txt Crawl-delay: 20. */
  minDelayMs?: number;
  timeoutMs?: number;
  /** Called before each request — useful for progress logging during a snapshot run. */
  onRequest?: (url: string) => void;
}

export class PskClient {
  private readonly minDelayMs: number;
  private readonly timeoutMs: number;
  private readonly onRequest?: (url: string) => void;
  /** Sequential lane: every request awaits this promise chain, never runs concurrently. */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: PskClientOptions = {}) {
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onRequest = options.onRequest;
  }

  async getSports(): Promise<PskSport[]> {
    return this.getJson<PskSport[]>("/structure/api/v1_0/sports");
  }

  async getTournamentsForSport(sportId: string): Promise<PskSportTournaments> {
    return this.getJson<PskSportTournaments>(
      `/structure/api/v1_0/sport/${encodeURIComponent(sportId)}/tournaments?categories=true`,
    );
  }

  async getTournamentMatches(tournamentId: string): Promise<PskTournamentMatches> {
    return this.getJson<PskTournamentMatches>(
      `/structure/api/v1_0/tournament/${encodeURIComponent(tournamentId)}/matches`,
    );
  }

  async getFixtureMarkets(fixtureId: string): Promise<PskMarket[]> {
    return this.getJson<PskMarket[]>(
      `/markets/api/v1_0/fixture/${encodeURIComponent(fixtureId)}/markets`,
    );
  }

  /** Returns null (not an error) when a fixture has no scoreboard yet — common for not-yet-started fixtures. */
  async getFixtureScoreboard(fixtureId: string): Promise<PskScoreboard | null> {
    try {
      return await this.getJson<PskScoreboard>(
        `/stats-v2/api/v2_0/fixture/${encodeURIComponent(fixtureId)}/scoreboard`,
      );
    } catch (err) {
      if (err instanceof PskApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** ~100KB payload: every currently-live fixture across all sports, with inline markets. */
  async getLiveFixturesWidget(): Promise<PskLiveWidget> {
    return this.getJson<PskLiveWidget>("/structure/api/v1_0/widget/live/fixtures");
  }

  /** Turns a URL slug ("liga-prvaka") into its PSK id — what resolve_entity wraps in Phase 3. */
  async resolveSeoId(kind: SeoEntityKind, seoName: string): Promise<string> {
    return this.getJson<string>(
      `/seo/api/v1_0/${kind}/${encodeURIComponent(seoName)}/id`,
    );
  }

  // -- internals --------------------------------------------------------

  private getJson<T>(path: string): Promise<T> {
    // Chain onto the queue so calls are strictly sequential regardless of
    // how the caller invokes them (even Promise.all(...) stays serialized).
    const result = this.queue.then(() => this.throttledFetch<T>(path));
    // Swallow rejections in the queue chain itself so one failed request
    // does not permanently wedge the lane for subsequent calls.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async throttledFetch<T>(path: string): Promise<T> {
    const wait = this.minDelayMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const url = `${BASE_URL}${path}`;
    this.onRequest?.(url);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** attempt);
      try {
        return await fetchJsonOnce<T>(url, this.timeoutMs);
      } catch (err) {
        lastError = err;
        // Do not retry 4xx — retrying a bad request or a genuine 404 wastes time.
        if (err instanceof PskApiError && err.status < 500) throw err;
      }
    }
    throw lastError;
  }
}

async function fetchJsonOnce<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new PskApiError(url, res.status, await safeText(res));
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// Smoke test — run directly with `npx tsx src/fetchPsk.ts` to sanity-check
// the client against the live API. Not part of the snapshot build; step 3's
// buildFixtures.ts imports the exports above instead of running this.
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new PskClient({
    minDelayMs: 1000, // fast pace acceptable for a 3-call manual smoke test
    onRequest: (url) => console.error(`-> ${url}`),
  });

  const sports = await client.getSports();
  const cricket = sports.find((s) => s.seoName === "kriket");
  console.log(`sports: ${sports.length} total, cricket present: ${Boolean(cricket)} (${cricket?.fixturesCount ?? 0} fixtures)`);

  if (cricket) {
    const { tournaments } = await client.getTournamentsForSport(cricket.id);
    console.log(`cricket tournaments: ${tournaments.length}`);
    const first = tournaments[0];
    if (first) {
      const { fixtures } = await client.getTournamentMatches(first.id);
      console.log(`sample tournament "${first.name}": ${fixtures.length} fixtures`);
    }
  }
}
