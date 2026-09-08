/**
 * Standalone test harness for tools.ts (Phase 3a — see docs/phase-3-agent-actions.md).
 *
 * No Azure, no RN, no mic: exercises runTool() the same way a RealtimeClient
 * eventually will (name + JSON-string arguments in, JSON-string result out)
 * and checks the results against the committed snapshot. Same style as
 * validate.ts — plain checks, console output, process.exitCode.
 *
 * Usage:
 *   npx tsx src/testTools.ts
 */

import { runTool, TOOL_SCHEMAS } from "./tools.ts";

let failures = 0;

function check(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.error(`  PASS  ${description}`);
  } else {
    failures++;
    console.error(`  FAIL  ${description}${detail ? ` — ${detail}` : ""}`);
  }
}

function call(name: string, args: unknown): any {
  return JSON.parse(runTool(name, JSON.stringify(args)));
}

console.error("--- search_fixtures ---");

const realMadrid = call("search_fixtures", { query: "Real Madrid" });
check("exact match: 'Real Madrid' -> exactly 1 fixture", realMadrid.matches?.length === 1, JSON.stringify(realMadrid));
check(
  "exact match result is the right fixture",
  realMadrid.matches?.[0]?.home === "Real Madrid" || realMadrid.matches?.[0]?.away === "Real Madrid",
);

const championsLeague = call("search_fixtures", { query: "Champions League" });
check(
  "ambiguous match: 'Champions League' -> several fixtures",
  Array.isArray(championsLeague.matches) && championsLeague.matches.length > 1,
  `got ${championsLeague.matches?.length}`,
);

const notFound = call("search_fixtures", { query: "Spain vs Argentina" });
check(
  "not-found match: 'Spain vs Argentina' -> zero fixtures, not an error",
  Array.isArray(notFound.matches) && notFound.matches.length === 0 && notFound.error === undefined,
  JSON.stringify(notFound),
);

const synthetic = call("search_fixtures", { query: "India vs Australia" });
check(
  "synthetic fixture findable: 'India vs Australia' -> exactly 1 fixture",
  synthetic.matches?.length === 1,
  JSON.stringify(synthetic),
);

console.error("\n--- get_fixture_details ---");

const rmFixtureId = realMadrid.matches?.[0]?.fixtureId;
const details = rmFixtureId ? call("get_fixture_details", { fixtureId: rmFixtureId }) : { error: "no fixtureId from search" };
check("get_fixture_details: real fixture resolves", Boolean(details.fixture), JSON.stringify(details));
check(
  "get_fixture_details: markets are English-labeled",
  Array.isArray(details.markets) && details.markets.length > 0 && details.markets.every((m: any) => typeof m.englishLabel === "string" && m.englishLabel.length > 0),
  JSON.stringify(details.markets?.[0]),
);

const badDetails = call("get_fixture_details", { fixtureId: "nope-not-real" });
check("get_fixture_details: unknown id -> typed error, no throw", typeof badDetails.error === "string");

console.error("\n--- get_odds ---");

const odds = rmFixtureId ? call("get_odds", { fixtureId: rmFixtureId, market: "Match Winner" }) : { error: "no fixtureId" };
check(
  "get_odds: filtered by 'Match Winner' returns the 1X2 market",
  Array.isArray(odds.markets) && odds.markets.some((m: any) => m.englishLabel === "Match Winner"),
  JSON.stringify(odds),
);

const badOdds = rmFixtureId ? call("get_odds", { fixtureId: rmFixtureId, market: "Not A Real Market" }) : {};
check("get_odds: unknown market filter -> typed error", typeof badOdds.error === "string", JSON.stringify(badOdds));

console.error("\n--- get_my_activity ---");

const activity = call("get_my_activity", {});
check("get_my_activity: has walletBalance", typeof activity.walletBalance?.amount === "number" && activity.walletBalance.amount > 0, JSON.stringify(activity.walletBalance));
check("get_my_activity: has favouriteTeams", Array.isArray(activity.favouriteTeams) && activity.favouriteTeams.length > 0);
check("get_my_activity: has sessionStakeLimit", typeof activity.limits?.sessionStakeLimit === "number");

console.error("\n--- navigate (Tier 2) ---");

const nav = call("navigate", { screen: "betslip", params: { fixtureId: rmFixtureId } });
check("navigate: known screen -> navigated", nav.status === "navigated" && nav.screen === "betslip", JSON.stringify(nav));

const badNav = call("navigate", { screen: "deleteAllData" });
check("navigate: unknown screen -> typed error, no throw", typeof badNav.error === "string", JSON.stringify(badNav));

console.error("\n--- propose_bet (Tier 3 — must never execute) ---");

const validBet = rmFixtureId
  ? call("propose_bet", { fixtureId: rmFixtureId, market: "Match Winner", selection: "Home", stake: 10 })
  : { error: "no fixtureId" };
check(
  "propose_bet: valid proposal -> awaiting_user_confirmation, never placed",
  validBet.status === "awaiting_user_confirmation",
  JSON.stringify(validBet),
);
check(
  "propose_bet: potentialReturn = stake * odds, computed correctly",
  typeof validBet.odds === "number" && Math.abs(validBet.potentialReturn - Math.round(validBet.stake * validBet.odds * 100) / 100) < 1e-9,
  JSON.stringify(validBet),
);
check("propose_bet: embeds a navigate intent to the bet slip", validBet.navigate?.screen === "betslip");

const overLimitBet = rmFixtureId
  ? call("propose_bet", { fixtureId: rmFixtureId, market: "Match Winner", selection: "Home", stake: 10_000 })
  : {};
check(
  "propose_bet: stake far over the session limit -> refused, not confirmed",
  overLimitBet.status === "refused" && overLimitBet.reason === "over_session_limit",
  JSON.stringify(overLimitBet),
);

const unknownFixtureBet = call("propose_bet", { fixtureId: "nope", market: "Match Winner", selection: "Home", stake: 10 });
check("propose_bet: unknown fixture -> typed error", typeof unknownFixtureBet.error === "string");

const unknownMarketBet = rmFixtureId
  ? call("propose_bet", { fixtureId: rmFixtureId, market: "Not A Real Market", selection: "Home", stake: 10 })
  : {};
check("propose_bet: unknown market -> typed error", typeof unknownMarketBet.error === "string");

const unknownSelectionBet = rmFixtureId
  ? call("propose_bet", { fixtureId: rmFixtureId, market: "Match Winner", selection: "Purple", stake: 10 })
  : {};
check("propose_bet: unknown selection -> typed error", typeof unknownSelectionBet.error === "string");

console.error("\n--- propose_deposit (Tier 3 — must never execute) ---");

const validDeposit = call("propose_deposit", { amount: 25 });
check("propose_deposit: valid proposal -> awaiting_user_confirmation, never completed", validDeposit.status === "awaiting_user_confirmation", JSON.stringify(validDeposit));

const badDeposit = call("propose_deposit", { amount: -5 });
check("propose_deposit: non-positive amount -> typed error", typeof badDeposit.error === "string");

console.error("\n--- structural proof: no execute/confirm tool exists ---");

const allToolNames = TOOL_SCHEMAS.map((t) => t.name).sort();
const expectedToolNames = [
  "get_fixture_details",
  "get_my_activity",
  "get_odds",
  "navigate",
  "propose_bet",
  "propose_deposit",
  "search_fixtures",
].sort();
check(
  "TOOL_SCHEMAS is exactly this allowlist — no confirm_bet/execute_bet/place_bet snuck in",
  JSON.stringify(allToolNames) === JSON.stringify(expectedToolNames),
  `got: ${allToolNames.join(", ")}`,
);

console.error("\n--- dispatcher edge cases ---");

const unknownTool = JSON.parse(runTool("delete_everything", "{}"));
check("runTool: unknown tool name -> typed error, no throw", typeof unknownTool.error === "string");

const malformed = JSON.parse(runTool("get_my_activity", "{not valid json"));
check("runTool: malformed arguments JSON -> typed error, no throw", typeof malformed.error === "string");

console.error(`\n${failures === 0 ? "OK" : "FAILED"}: ${failures} failure(s).`);
if (failures > 0) process.exitCode = 1;
