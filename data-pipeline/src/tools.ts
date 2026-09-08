/**
 * Agent tools — Tier 1 Read (Phase 3a) + Tier 2/3 (Phase 3b). See
 * docs/phase-3-agent-actions.md.
 *
 * Pure functions over Phase 0's committed dist/*.json, plus one small
 * dispatcher. No network, no RN, no Azure — this is what a RealtimeClient's
 * `response.function_call_arguments.done` handler will eventually call, but
 * it works standalone today via testTools.ts.
 *
 * Tier 3 (`propose_bet`, `propose_deposit`) can NEVER execute anything: each
 * handler's only possible outcomes are an error, a policy refusal, or
 * `{status: "awaiting_user_confirmation", ...}`. There is no `confirm_*` or
 * `execute_*` tool anywhere in this file, or planned anywhere in this
 * project — the transition from "proposed" to "placed" only happens on a
 * real user tap in the real UI (Phase 2), which then calls PSK's own
 * authenticated betslip API directly. testTools.ts asserts this structurally
 * (an exhaustive allowlist of every tool name that exists), not just by
 * convention.
 *
 * Deliberately one file: seven tools does not need a plugin architecture.
 */

import { readFileSync } from "node:fs";
import type { Fixture, LexiconEntry, Market, UserProfile } from "./types.ts";

// ---------------------------------------------------------------------------
// Data: loaded once, from the committed snapshot only.
// ---------------------------------------------------------------------------

function readJson<T>(filename: string): T {
  const url = new URL(`../dist/${filename}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

const fixtures = readJson<Fixture[]>("fixtures.json");
const markets = readJson<Market[]>("markets.json");
const lexicon = readJson<LexiconEntry[]>("lexicon.json");
const userProfile = readJson<UserProfile>("userProfile.json");

const fixturesById = new Map(fixtures.map((f) => [f.id, f]));
const marketsByFixtureId = new Map<string, Market[]>();
for (const m of markets) {
  const list = marketsByFixtureId.get(m.fixtureId) ?? [];
  list.push(m);
  marketsByFixtureId.set(m.fixtureId, list);
}
const lexiconByType = new Map(lexicon.map((e) => [e.marketTypeNameHr, e]));

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

interface FixtureSummary {
  fixtureId: string;
  sportNameEn: string;
  tournamentNameEn: string;
  home: string;
  away: string;
  kickoffUtc: string;
  status: Fixture["status"];
  liveScore?: Fixture["liveScore"];
}

interface MarketSummary {
  marketTypeNameHr: string;
  englishLabel: string;
  outcomes: { name: string; labelEn: string; odds: number }[];
}

function toFixtureSummary(f: Fixture): FixtureSummary {
  return {
    fixtureId: f.id,
    sportNameEn: f.sportNameEn,
    tournamentNameEn: f.tournamentNameEn,
    home: f.home.nameEn ?? f.home.name,
    away: f.away.nameEn ?? f.away.name,
    kickoffUtc: f.kickoffUtc,
    status: f.status,
    ...(f.liveScore ? { liveScore: f.liveScore } : {}),
  };
}

/** Falls back to the raw Croatian name/label if a market somehow has no lexicon entry — never throws. */
function toMarketSummary(m: Market): MarketSummary {
  const entry = lexiconByType.get(m.marketTypeNameHr);
  return {
    marketTypeNameHr: m.marketTypeNameHr,
    englishLabel: entry?.englishLabel ?? m.marketTypeNameHr,
    outcomes: m.outcomes.map((o) => ({
      name: o.name,
      labelEn: entry?.outcomeLabelsEn[o.name] ?? o.name,
      odds: o.odds,
    })),
  };
}

function marketsForFixture(fixtureId: string): Market[] {
  return marketsByFixtureId.get(fixtureId) ?? [];
}

// ---------------------------------------------------------------------------
// search_fixtures
// ---------------------------------------------------------------------------

const SEARCH_STOPWORDS = new Set(["vs", "versus", "v", "against", "the", "and", "match", "game"]);

function significantWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9À-ž]+/i)
    .filter((w) => w && !SEARCH_STOPWORDS.has(w));
  return words.length > 0 ? words : [text.trim().toLowerCase()].filter(Boolean);
}

interface SearchFixturesArgs {
  query: string;
  sport?: string;
  when?: "live" | "today" | "upcoming";
}

function searchFixtures(args: SearchFixturesArgs): { matches: FixtureSummary[] } {
  const words = significantWords(args.query ?? "");
  const now = Date.now();

  const matches = fixtures.filter((f) => {
    const haystack = [
      f.home.name,
      f.home.nameEn,
      f.away.name,
      f.away.nameEn,
      f.tournamentNameEn,
      f.tournamentNameHr,
      f.sportNameEn,
      f.sportNameHr,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (words.length > 0 && !words.every((w) => haystack.includes(w))) return false;

    if (args.sport) {
      const sportWanted = args.sport.toLowerCase();
      if (!f.sportNameEn.toLowerCase().includes(sportWanted) && !f.sportNameHr.toLowerCase().includes(sportWanted)) {
        return false;
      }
    }

    if (args.when === "live" && f.status !== "LIVE") return false;
    if (args.when === "upcoming" && f.status !== "SCHEDULED") return false;
    if (args.when === "today") {
      const kickoff = Date.parse(f.kickoffUtc);
      const withinDay = Math.abs(kickoff - now) <= 24 * 60 * 60 * 1000;
      if (f.status !== "LIVE" && !withinDay) return false;
    }

    return true;
  });

  return { matches: matches.map(toFixtureSummary) };
}

// ---------------------------------------------------------------------------
// get_fixture_details
// ---------------------------------------------------------------------------

interface GetFixtureDetailsArgs {
  fixtureId: string;
}

function getFixtureDetails(args: GetFixtureDetailsArgs) {
  const fixture = fixturesById.get(args.fixtureId);
  if (!fixture) return { error: `No fixture found with id "${args.fixtureId}".` };
  return {
    fixture: toFixtureSummary(fixture),
    markets: marketsForFixture(fixture.id).map(toMarketSummary),
  };
}

// ---------------------------------------------------------------------------
// get_odds
// ---------------------------------------------------------------------------

interface GetOddsArgs {
  fixtureId: string;
  market?: string;
}

function getOdds(args: GetOddsArgs) {
  const fixture = fixturesById.get(args.fixtureId);
  if (!fixture) return { error: `No fixture found with id "${args.fixtureId}".` };

  let fixtureMarkets = marketsForFixture(fixture.id);
  if (args.market) {
    const wanted = args.market.toLowerCase();
    const filtered = fixtureMarkets.filter((m) => {
      const entry = lexiconByType.get(m.marketTypeNameHr);
      return (
        m.marketTypeNameHr.toLowerCase().includes(wanted) ||
        (entry?.englishLabel.toLowerCase().includes(wanted) ?? false)
      );
    });
    if (filtered.length === 0) {
      return { error: `No market matching "${args.market}" found for fixture "${args.fixtureId}".` };
    }
    fixtureMarkets = filtered;
  }

  return { fixtureId: fixture.id, markets: fixtureMarkets.map(toMarketSummary) };
}

// ---------------------------------------------------------------------------
// get_my_activity
// ---------------------------------------------------------------------------

function getMyActivity() {
  return userProfile;
}

// ---------------------------------------------------------------------------
// navigate  (Tier 2 — moves the UI, no financial effect)
// ---------------------------------------------------------------------------

/** Real fortuna_screen_name values from Phase 0's analytics recon — the only screens this agent may target. */
const KNOWN_SCREENS = [
  "homepage",
  "searchPrematch",
  "searchLive",
  "prematchDetail",
  "liveDetail",
  "prematchMatchesOverview",
  "betslip",
  "ticketHistory",
  "my_account",
  "webviewresponsibleGame",
  "promotions",
] as const;

interface NavigateArgs {
  screen: string;
  params?: Record<string, string>;
}

function navigate(args: NavigateArgs) {
  if (!(KNOWN_SCREENS as readonly string[]).includes(args.screen)) {
    return { error: `Unknown screen "${args.screen}". Known screens: ${KNOWN_SCREENS.join(", ")}.` };
  }
  // No real screen layer exists yet (Phase 2 not started) — this returns the
  // navigation intent a real UI will consume, the same way Tier 1 tools
  // return data with no voice layer yet to speak it.
  return { status: "navigated", screen: args.screen, params: args.params ?? {} };
}

// ---------------------------------------------------------------------------
// propose_bet  (Tier 3 — CANNOT execute; see the file header guarantee)
// ---------------------------------------------------------------------------

interface ProposeBetArgs {
  fixtureId: string;
  market: string;
  selection: string;
  stake: number;
  currency?: string;
}

function proposeBet(args: ProposeBetArgs) {
  const fixture = fixturesById.get(args.fixtureId);
  if (!fixture) return { error: `No fixture found with id "${args.fixtureId}".` };

  const wantedMarket = (args.market ?? "").toLowerCase();
  const market = marketsForFixture(fixture.id).find((m) => {
    const entry = lexiconByType.get(m.marketTypeNameHr);
    return (
      m.marketTypeNameHr.toLowerCase().includes(wantedMarket) ||
      (entry?.englishLabel.toLowerCase().includes(wantedMarket) ?? false)
    );
  });
  if (!market) return { error: `No market matching "${args.market}" found for fixture "${args.fixtureId}".` };

  const entry = lexiconByType.get(market.marketTypeNameHr);
  const wantedSelection = (args.selection ?? "").toLowerCase();
  const outcome = market.outcomes.find(
    (o) =>
      o.name.toLowerCase() === wantedSelection ||
      (entry?.outcomeLabelsEn[o.name]?.toLowerCase() ?? "") === wantedSelection,
  );
  if (!outcome) {
    const valid = market.outcomes.map((o) => entry?.outcomeLabelsEn[o.name] ?? o.name).join(", ");
    return { error: `No selection matching "${args.selection}" on market "${market.marketTypeNameHr}". Valid selections: ${valid}.` };
  }

  if (typeof args.stake !== "number" || !Number.isFinite(args.stake) || args.stake <= 0) {
    return { error: `Stake must be a positive number; got ${JSON.stringify(args.stake)}.` };
  }
  // Responsible-gaming backstop, enforced in code, not just instructions:
  // no proposal can exceed the session limit or the wallet balance, no
  // matter how the model was asked to justify it.
  if (args.stake > userProfile.limits.sessionStakeLimit) {
    return {
      status: "refused",
      reason: "over_session_limit",
      message: `That stake exceeds the session limit of ${userProfile.limits.sessionStakeLimit} ${userProfile.limits.currency}.`,
      navigate: { screen: "webviewresponsibleGame", params: {} },
    };
  }
  if (args.stake > userProfile.walletBalance.amount) {
    return {
      status: "refused",
      reason: "insufficient_balance",
      message: `That stake exceeds the current wallet balance of ${userProfile.walletBalance.amount} ${userProfile.walletBalance.currency}.`,
    };
  }

  const currency = args.currency ?? userProfile.walletBalance.currency;
  const potentialReturn = Math.round(args.stake * outcome.odds * 100) / 100;

  return {
    status: "awaiting_user_confirmation",
    fixtureId: fixture.id,
    market: entry?.englishLabel ?? market.marketTypeNameHr,
    selection: entry?.outcomeLabelsEn[outcome.name] ?? outcome.name,
    odds: outcome.odds,
    stake: args.stake,
    currency,
    potentialReturn,
    navigate: { screen: "betslip", params: { fixtureId: fixture.id, marketId: market.id, outcomeId: outcome.id } },
  };
}

// ---------------------------------------------------------------------------
// propose_deposit  (Tier 3 — CANNOT execute; same guarantee as propose_bet)
// ---------------------------------------------------------------------------

interface ProposeDepositArgs {
  amount: number;
  currency?: string;
}

function proposeDeposit(args: ProposeDepositArgs) {
  if (typeof args.amount !== "number" || !Number.isFinite(args.amount) || args.amount <= 0) {
    return { error: `Amount must be a positive number; got ${JSON.stringify(args.amount)}.` };
  }
  return {
    status: "awaiting_user_confirmation",
    amount: args.amount,
    currency: args.currency ?? userProfile.walletBalance.currency,
    navigate: { screen: "my_account", params: { action: "deposit" } },
  };
}

// ---------------------------------------------------------------------------
// Tool schemas — GA flat shape (name/description/parameters at top level).
// This is exactly what Phase 1's session.update "tools" array will carry.
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = [
  {
    type: "function",
    name: "search_fixtures",
    description:
      "Search for sports fixtures/matches by free text (team names, tournament, sport). Returns ALL plausible matches, including zero. Never assume which one the user means when there is more than one — ask.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free text describing the match, e.g. 'Real Madrid vs Inter', 'Champions League tonight', 'India vs Australia'.",
        },
        sport: { type: "string", description: "Optional sport filter, e.g. 'Football', 'Cricket'." },
        when: {
          type: "string",
          enum: ["live", "today", "upcoming"],
          description:
            "Only set this if the user explicitly asked for a time-based filter (e.g. said 'live', 'today', or 'upcoming'/'later'). Do NOT default to 'upcoming' for an ordinary team/match lookup — omitting `when` searches ALL fixtures regardless of status and is correct for most queries. Setting it unprompted can hide a real, currently-live match that a broader search would have found.",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "get_fixture_details",
    description: "Get full details (teams, kickoff, live score, headline markets) for one fixture by id.",
    parameters: {
      type: "object",
      properties: { fixtureId: { type: "string", description: "A fixture id returned by search_fixtures." } },
      required: ["fixtureId"],
    },
  },
  {
    type: "function",
    name: "get_odds",
    description: "Get current odds for a fixture, optionally filtered to one market (e.g. 'Match Winner').",
    parameters: {
      type: "object",
      properties: {
        fixtureId: { type: "string", description: "A fixture id returned by search_fixtures." },
        market: { type: "string", description: "Optional market name filter, e.g. 'Match Winner', 'Both Teams to Score'." },
      },
      required: ["fixtureId"],
    },
  },
  {
    type: "function",
    name: "get_my_activity",
    description: "Get the user's own profile: favourite teams, followed tournaments, wallet balance, session limits, and open tickets. No arguments.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "navigate",
    description: "Move the app to a specific screen. No financial effect. Use this for anything that isn't placing a bet or a deposit — e.g. showing bet history or the responsible-gaming page.",
    parameters: {
      type: "object",
      properties: {
        screen: {
          type: "string",
          enum: [
            "homepage", "searchPrematch", "searchLive", "prematchDetail", "liveDetail",
            "prematchMatchesOverview", "betslip", "ticketHistory", "my_account",
            "webviewresponsibleGame", "promotions",
          ],
          description: "The target screen.",
        },
        params: { type: "object", description: "Optional screen-specific parameters, e.g. { fixtureId }." },
      },
      required: ["screen"],
    },
  },
  {
    type: "function",
    name: "propose_bet",
    description:
      "Prepare a bet for the user to review and confirm. This tool can NEVER place a bet — it only ever returns a proposal awaiting the user's own tap, or a refusal. Requires an exact fixture, market, selection and stake; ask the user rather than guessing any of these.",
    parameters: {
      type: "object",
      properties: {
        fixtureId: { type: "string", description: "A fixture id returned by search_fixtures." },
        market: { type: "string", description: "The market, e.g. 'Match Winner'." },
        selection: { type: "string", description: "The chosen outcome, e.g. 'Home', 'Draw', 'Yes'." },
        stake: { type: "number", description: "Stake amount. Never assume or round up a stake the user didn't state." },
        currency: { type: "string", description: "Optional; defaults to the user's own wallet currency." },
      },
      required: ["fixtureId", "market", "selection", "stake"],
    },
  },
  {
    type: "function",
    name: "propose_deposit",
    description: "Prepare a deposit for the user to review and confirm. This tool can NEVER complete a deposit — it only ever returns a proposal awaiting the user's own tap.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Deposit amount. Never assume a value the user didn't state." },
        currency: { type: "string", description: "Optional; defaults to the user's own wallet currency." },
      },
      required: ["amount"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const TOOLS: Record<string, (args: any) => unknown> = {
  search_fixtures: searchFixtures,
  get_fixture_details: getFixtureDetails,
  get_odds: getOdds,
  get_my_activity: getMyActivity,
  navigate,
  propose_bet: proposeBet,
  propose_deposit: proposeDeposit,
};

/**
 * Matches the GA function-calling contract: `name` + `arguments` (a JSON
 * string) in, a JSON string out — exactly what a `function_call_output`
 * item's `output` field expects. Never throws: an unknown tool, malformed
 * arguments, or a handler error all come back as a JSON `{error}` string so
 * the model can recover instead of the session breaking.
 */
export function runTool(name: string, argumentsJson: string): string {
  const handler = TOOLS[name];
  if (!handler) return JSON.stringify({ error: `Unknown tool: "${name}".` });

  let args: unknown;
  try {
    args = argumentsJson ? JSON.parse(argumentsJson) : {};
  } catch {
    return JSON.stringify({ error: `Malformed arguments JSON for tool "${name}".` });
  }

  try {
    return JSON.stringify(handler(args));
  } catch (err) {
    return JSON.stringify({ error: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
