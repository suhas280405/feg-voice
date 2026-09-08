/**
 * Shared schema contract for the PSK voice-agent data layer (Phase 0).
 *
 * These interfaces describe the shape of dist/fixtures.json, dist/markets.json,
 * dist/lexicon.json and dist/userProfile.json. Later phases (voice tools in
 * Phase 3, screens in Phase 2) import this file and read the committed JSON —
 * they do not talk to the PSK API or the CSVs directly.
 *
 * See docs/phase-0-foundations.md for the rationale behind each field.
 */

export type FixtureStatus = "SCHEDULED" | "LIVE" | "FINISHED";

export interface FixtureParticipant {
  /** PSK "ufo:team:…" id where known, else a stable slug for synthetic data. */
  id: string;
  /** PSK's own name. Mostly already language-neutral (club names are proper nouns); country-based team names may be Croatian (e.g. "Engleska"). */
  name: string;
  /**
   * English display name. Populated for the synthetic fixture and for the
   * handful of real country names we translate opportunistically; absent
   * otherwise. Consumers should fall back to `name` when this is undefined
   * rather than treating its absence as an error.
   */
  nameEn?: string;
}

export interface FixtureLiveScore {
  home: number;
  away: number;
  /** e.g. "1. poluvrijeme - 7. min." from PSK's scoreboard endpoint. */
  gameTime?: string;
}

export interface Fixture {
  /** Real "ufo:mtch:…" id, or "demo:mtch:…" for the one synthetic fixture. */
  id: string;

  sportId: string;
  sportNameEn: string;
  /** PSK's own Croatian sport name, e.g. "Nogomet", "Kriket". */
  sportNameHr: string;

  tournamentId: string;
  tournamentNameEn: string;
  tournamentNameHr: string;

  /** Slug used by resolve_entity to turn "Liga prvaka" into this fixture's tournament. */
  seoName: string;

  home: FixtureParticipant;
  away: FixtureParticipant;

  /** ISO 8601, already remapped onto the frozen demo clock (see demoClock.ts). */
  kickoffUtc: string;

  status: FixtureStatus;
  liveScore?: FixtureLiveScore;

  /** References into markets.json (Market.id values belonging to this fixture). */
  marketIds: string[];

  /**
   * true only for the hand-authored India vs Australia fixture, and only if
   * no real live fixture matched it at snapshot time. Every other fixture is
   * unmodified PSK data. Never presented to the user as distinguishable from
   * real data — this flag is for our own audit trail, not the UI.
   */
  isSynthetic: boolean;
}

export interface MarketOutcome {
  /** Real "ufo:opt:…" id, or a synthetic-but-stable id. */
  id: string;
  /** PSK's own outcome label, e.g. "1", "X", "2", "Da", "Ne", "+ 165.5". */
  name: string;
  odds: number;
  /** Present when PSK's markets endpoint reports drift; omitted otherwise. */
  previousOdds?: number;
}

export interface Market {
  id: string;
  fixtureId: string;
  marketTypeId: string;
  /** PSK's Croatian market-type name, e.g. "Osnovna ponuda". Lexicon join key. */
  marketTypeNameHr: string;
  outcomes: MarketOutcome[];
}

/**
 * One row per distinct marketTypeNameHr actually present in markets.json.
 * Built from real data, never invented ahead of what the snapshot contains —
 * an unmapped market at runtime is a bug, and the agent tools should treat it
 * as an ask_clarification case rather than guess a translation.
 */
export interface LexiconEntry {
  marketTypeNameHr: string;
  /** Coarse category the tools reason about, e.g. "1X2" | "OVER_UNDER" | "BTTS" | "OTHER". */
  canonicalMarket: string;
  /** Plain-English label the agent speaks, e.g. "Match Winner". */
  englishLabel: string;
  /** Per-outcome translations, e.g. { "1": "Home win", "Da": "Yes" }. */
  outcomeLabelsEn: Record<string, string>;
}

export interface OpenTicket {
  id: string;
  fixtureId: string;
  market: string;
  stake: number;
  potentialReturn: number;
}

export interface UserProfile {
  /** Anonymised id derived from the provided CSVs, never a real PlayerID. */
  userId: string;
  favouriteTeams: string[];
  followedTournaments: string[];
  openTickets: OpenTicket[];
  /**
   * Demo-only balance — never a real PSK wallet. Real balance is auth-gated
   * (pams/api/v2/balances) and this project never touches it; the whole
   * bet slip is local for the same reason. This is just a plausible number
   * to speak back when the agent is asked "what's my balance".
   */
  walletBalance: {
    amount: number;
    currency: "EUR";
  };
  limits: {
    sessionStakeLimit: number;
    currency: "EUR";
  };
}

/** Written alongside each dist/*.json file's siblings for traceability. */
export interface SnapshotMeta {
  /** When the pipeline last ran, ISO 8601. */
  builtAt: string;
  /** The frozen "now" all kickoff times were remapped relative to. */
  demoNowUtc: string;
  /** Source tournaments requested from the PSK API for this snapshot. */
  sourceTournaments: string[];
}
