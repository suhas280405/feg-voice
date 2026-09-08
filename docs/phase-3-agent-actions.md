# Phase 3 — Agent Actions (Tier 1 Read + Tier 2/3 Sensitive Actions)

**Status: implemented and verified, both halves.** This document originally planned Tier 1 only ("Phase 3a"); Tier 2/3 ("Phase 3b") was added straight into the same file and the same simple pattern once 3a was done. It now records what was actually built, because the build changed the plan repeatedly — mostly by cutting things the plan proposed that turned out not to be needed. Companion to [phase-0-foundations.md](./phase-0-foundations.md) and [phase-1-voice-transport.md](./phase-1-voice-transport.md), pulled forward from Phase 3 of [challenge-02-voice-agent-plan.md](./challenge-02-voice-agent-plan.md).

## What changed from the original plan, and why

The first draft specified a 7-task breakdown for Tier 1 alone, with a dedicated "dispatcher" as its own designed component and an implied new package boundary. None of that survived contact with actually writing the code:

| Planned | Built instead | Why |
|---|---|---|
| A separate package (implied, mirroring Phase 1's `voice-transport`) | **No new package**, for either tier. Everything lives in the existing `data-pipeline/src/` | It already owns `types.ts` and the right TypeScript config. Zero new `npm install`. |
| A "dispatcher" as a named, separately-designed component | **One function, `runTool`, backed by an object-literal lookup** — 4 entries, then 7 | Seven tools still doesn't need a plugin architecture. |
| Schemas, handlers, and the dispatcher as separate tasks/files | **All seven tools — schema, handler, and all — in one file, `tools.ts`** (~440 lines) | Splitting by concern-that-isn't-really-a-seam was planning granularity, not a real boundary in the code. |
| Tier 3's "Confirmation Gate" specified as its own component (session mute, sheet rendering, audit trail) | **It isn't a component at all — it's a property of the tool contract.** `propose_bet`/`propose_deposit` can only ever return an error, a refusal, or `{status: "awaiting_user_confirmation"}`. There is no tool that transitions that status to "placed". | The gate doesn't need code to enforce it once no code path exists that could violate it. Mute-mic/sheet-rendering is real, but it's Phase 2 UI behavior, not agent-action logic. |
| Responsible-gaming policy specified as a separate policy-layer module | **Two inline checks in `proposeBet`**, against `userProfile.limits.sessionStakeLimit` and `userProfile.walletBalance.amount` — both already loaded for `get_my_activity` | Reused data already in scope. A separate module would have imported the same two numbers through an extra layer. |
| `ask_clarification` planned as a fifth Tier 4 tool | **Not built as a tool at all.** `search_fixtures` already returns 0/1/many matches; several matches *is* the ambiguity signal the model acts on. | The behavior Tier 4 wanted already existed by construction in Tier 1 — adding a tool whose only job is "return true" would have been the over-engineering this whole exercise was trying to avoid. |

Net effect across both tiers: **2 files** (`tools.ts`, `testTools.ts`) plus 3 small edits to existing Phase 0 files, in a package that already existed. Seven tools, no framework, no abstraction layer, no fifth tool that would have done nothing.

## Goal (unchanged — this is what got verified)

Tier 1: given a structured tool call, return correct, speakable data for anything read-only — never inventing data, never guessing which fixture was meant. Tier 2/3: let the agent move the UI and prepare a bet or deposit for the user to review — while remaining **structurally incapable** of completing either, not just instructed not to.

## What was actually built

```
data-pipeline\src\
  tools.ts        7 tool schemas + 7 handlers + runTool(name, argsJson) dispatcher — one file
  testTools.ts    25 checks against the committed snapshot, styled like validate.ts
```

Plus the same three small edits to Phase 0 files as before (`types.ts` → `UserProfile.walletBalance`, `buildUserProfile.ts` derives it, `validate.ts` checks it).

**All seven tools, exactly as shipped:**

```ts
// Tier 1 — Read
search_fixtures({query, sport?, when?}) -> {matches: FixtureSummary[]}      // 0, 1, or many are all correct
get_fixture_details({fixtureId}) -> {fixture, markets} | {error}
get_odds({fixtureId, market?}) -> {fixtureId, markets} | {error}
get_my_activity() -> UserProfile                                            // incl. walletBalance

// Tier 2 — Navigate (no financial effect)
navigate({screen, params?}) -> {status:"navigated", screen, params} | {error}
  // screen is a closed enum of real fortuna_screen_name values from Phase 0's
  // analytics recon — homepage, prematchDetail, betslip, ticketHistory,
  // webviewresponsibleGame, etc. Anything else is a typed error.

// Tier 3 — Propose (CANNOT execute)
propose_bet({fixtureId, market, selection, stake, currency?})
  -> {status:"awaiting_user_confirmation", odds, stake, potentialReturn, navigate: {screen:"betslip", ...}}
  |  {status:"refused", reason:"over_session_limit"|"insufficient_balance", message}
  |  {error}                                    // unknown fixture/market/selection, bad stake
propose_deposit({amount, currency?})
  -> {status:"awaiting_user_confirmation", amount, currency, navigate: {screen:"my_account", ...}}
  |  {error}
```

`propose_bet` resolves `market` and `selection` the same fuzzy way `get_odds` already does (case-insensitive against the Croatian name or the English label from the lexicon) — reused, not reimplemented. Its only three possible outcomes are `error`, `refused`, or `awaiting_user_confirmation`; there is no fourth outcome and no tool anywhere that can move a proposal to "placed."

## What Phase 3 IS

- All seven tools, fully implemented, reading only Phase 0's committed `dist/*.json` — no network, no RN, no Azure anywhere in this code.
- A **structural** (not instructional) guarantee against unauthorized spending: verified by an exhaustive allowlist test asserting `TOOL_SCHEMAS` contains exactly these seven names and nothing resembling `confirm_bet`/`execute_bet`/`place_bet`.
- A code-level responsible-gaming backstop: any stake over the session limit or the wallet balance is refused before a proposal is ever formed, regardless of how the request was phrased.
- A wallet balance, part of `UserProfile` — demo-only by design, same reasoning as the local-only bet slip.
- A test harness that has actually run and actually passes.

## What Phase 3 IS NOT

- **Not the Confirmation Gate's UI behavior** — muting the mic while a sheet is open, rendering the sheet, the on-screen audit trail. Those are Phase 2 (screens), which hasn't started. This phase produces exactly the payload that UI will render; it doesn't render anything.
- **Not wired into voice yet.** `runTool` is what a `RealtimeClient`'s handler for `response.function_call_arguments.done` will call — once Phase 1 has a mock or real client, that's a one-line wire-up. Not written yet because Phase 1's transport work is paused.
- **Not dependent on your teammate's RN project in any way.** Nothing here needed its file path or existence to be built or verified.

## Verification (what was actually run)

```
$ npm run typecheck                                 # clean
$ npm run build:userprofile && npm run validate
  Wallet balance (demo only): 480 EUR
  OK: all cross-references valid. No dangling references, full lexicon coverage.

$ npm run test:tools
  --- search_fixtures ---           5 checks, incl. Spain-vs-Argentina -> [] and India-vs-Australia -> 1
  --- get_fixture_details ---       3 checks
  --- get_odds ---                  2 checks
  --- get_my_activity ---           3 checks
  --- navigate (Tier 2) ---         2 checks
  --- propose_bet (Tier 3) ---      7 checks, incl. potentialReturn = stake × odds computed correctly,
                                     and a 10,000-stake proposal refused (reason: over_session_limit),
                                     never confirmed
  --- propose_deposit (Tier 3) ---  2 checks
  --- structural: no execute tool --1 check: TOOL_SCHEMAS names == exact 7-item allowlist
  --- dispatcher edge cases ---     2 checks
  OK: 0 failure(s).  (25/25 checks passing)
```

## What's still genuinely open

- **Voice wiring** — `runTool` is not yet called from anywhere; that happens once Phase 1 produces a `RealtimeClient` (mock or real).
- **Phase 2 (screens)** — the Confirmation Gate's actual UI: the sheet, the mic mute, the audit trail. This phase hands it a ready-made payload; nothing renders it yet.
- **Your teammate's RN project path** — still unknown, still irrelevant to this phase, still not blocking anything here.
