/**
 * Validator — step 6 of Phase 0 (see docs/phase-0-foundations.md).
 *
 * Cross-checks the four committed dist/*.json files against each other and
 * fails loudly (non-zero exit) on any broken reference. This is the "no
 * dangling fixtureId references, no market without a lexicon entry"
 * acceptance criterion from the Phase 0 plan, made executable.
 *
 * Usage:
 *   npx tsx src/validate.ts
 */

import { readFile } from "node:fs/promises";
import type { Fixture, LexiconEntry, Market, SnapshotMeta, UserProfile } from "./types.ts";

async function readJson<T>(filename: string): Promise<T> {
  const url = new URL(`../dist/${filename}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as T;
}

async function main() {
  const errors: string[] = [];
  const warn = (msg: string) => errors.push(msg);

  const [fixtures, markets, lexicon, userProfile, meta] = await Promise.all([
    readJson<Fixture[]>("fixtures.json"),
    readJson<Market[]>("markets.json"),
    readJson<LexiconEntry[]>("lexicon.json"),
    readJson<UserProfile>("userProfile.json"),
    readJson<SnapshotMeta>("meta.json"),
  ]);

  console.error(
    `Loaded ${fixtures.length} fixtures, ${markets.length} markets, ${lexicon.length} lexicon entries, 1 user profile, 1 meta record.`,
  );

  // -- meta sanity ---------------------------------------------------------
  if (!meta.builtAt || Number.isNaN(Date.parse(meta.builtAt))) {
    warn(`meta.json: builtAt is not a valid ISO timestamp: ${JSON.stringify(meta.builtAt)}`);
  }
  if (!meta.demoNowUtc || Number.isNaN(Date.parse(meta.demoNowUtc))) {
    warn(`meta.json: demoNowUtc is not a valid ISO timestamp: ${JSON.stringify(meta.demoNowUtc)}`);
  }

  // -- fixtures: shape + internal consistency ------------------------------
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
  if (fixtureById.size !== fixtures.length) {
    warn(`fixtures.json: duplicate fixture ids present (${fixtures.length} entries, ${fixtureById.size} unique ids)`);
  }
  for (const f of fixtures) {
    if (Number.isNaN(Date.parse(f.kickoffUtc))) {
      warn(`fixture ${f.id}: kickoffUtc is not a valid ISO timestamp: ${JSON.stringify(f.kickoffUtc)}`);
    }
    if (f.status === "LIVE" && !f.liveScore) {
      warn(`fixture ${f.id}: status is LIVE but liveScore is missing`);
    }
  }

  // -- markets: every market's fixtureId must resolve, and vice versa -----
  const marketById = new Map(markets.map((m) => [m.id, m]));
  for (const m of markets) {
    if (!fixtureById.has(m.fixtureId)) {
      warn(`market ${m.id}: fixtureId ${JSON.stringify(m.fixtureId)} does not match any fixture`);
    }
    if (m.outcomes.length === 0) {
      warn(`market ${m.id} (${m.marketTypeNameHr}): has zero outcomes`);
    }
  }
  for (const f of fixtures) {
    for (const marketId of f.marketIds) {
      const m = marketById.get(marketId);
      if (!m) {
        warn(`fixture ${f.id}: marketIds references ${JSON.stringify(marketId)}, which does not exist in markets.json`);
      } else if (m.fixtureId !== f.id) {
        warn(`fixture ${f.id}: marketIds references market ${marketId}, but that market's fixtureId is ${m.fixtureId}`);
      }
    }
    // Every market that claims this fixture should also be listed in marketIds (catches a builder that forgot to record one).
    const claimed = new Set(f.marketIds);
    for (const m of markets) {
      if (m.fixtureId === f.id && !claimed.has(m.id)) {
        warn(`fixture ${f.id}: market ${m.id} claims this fixture but is missing from the fixture's marketIds`);
      }
    }
  }

  // -- lexicon: every market type and every outcome it uses must be covered --
  const lexiconByType = new Map(lexicon.map((e) => [e.marketTypeNameHr, e]));
  for (const m of markets) {
    const entry = lexiconByType.get(m.marketTypeNameHr);
    if (!entry) {
      warn(`market ${m.id}: marketTypeNameHr ${JSON.stringify(m.marketTypeNameHr)} has no lexicon entry`);
      continue;
    }
    for (const outcome of m.outcomes) {
      if (!(outcome.name in entry.outcomeLabelsEn)) {
        warn(
          `market ${m.id} (${m.marketTypeNameHr}): outcome ${JSON.stringify(outcome.name)} has no translation in its lexicon entry`,
        );
      }
    }
  }

  // -- user profile: openTickets must resolve against real fixtures/markets --
  for (const ticket of userProfile.openTickets) {
    const fixture = fixtureById.get(ticket.fixtureId);
    if (!fixture) {
      warn(`userProfile.openTickets[${ticket.id}]: fixtureId ${JSON.stringify(ticket.fixtureId)} does not match any fixture`);
      continue;
    }
    const hasMarket = markets.some((m) => m.fixtureId === fixture.id && m.marketTypeNameHr === ticket.market);
    if (!hasMarket) {
      warn(
        `userProfile.openTickets[${ticket.id}]: market ${JSON.stringify(ticket.market)} not found on fixture ${fixture.id}`,
      );
    }
    if (!(ticket.stake > 0)) {
      warn(`userProfile.openTickets[${ticket.id}]: stake is not positive (${ticket.stake})`);
    }
  }
  if (!(userProfile.limits.sessionStakeLimit > 0)) {
    warn(`userProfile.limits.sessionStakeLimit is not positive (${userProfile.limits.sessionStakeLimit})`);
  }
  if (!(userProfile.walletBalance.amount > 0)) {
    warn(`userProfile.walletBalance.amount is not positive (${userProfile.walletBalance.amount})`);
  }

  // -- report ---------------------------------------------------------------
  if (errors.length > 0) {
    console.error(`\nFAILED: ${errors.length} issue(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  console.error("\nOK: all cross-references valid. No dangling references, full lexicon coverage.");
}

await main();
