# Phase 0 — Foundations: Data Layer

Sub-plan for the first phase of [challenge-02-voice-agent-plan.md](./challenge-02-voice-agent-plan.md). Read that first — this document only expands Phase 0.

## Goal

Produce a **deterministic, offline-safe, committed data layer** — real PSK fixtures/markets/odds, a Croatian→English lexicon, and a synthetic user profile — that every later phase (voice tools, screens, gate, widgets) reads from. Nothing in Phase 0 depends on Azure, RN, or Xcode, and nothing in later phases should need to touch a network at demo time.

**Definition of done:** running one command regenerates `data-pipeline/dist/*.json` from the live PSK API and the provided CSVs, with zero manual edits except one clearly-flagged synthetic fixture. Those JSON files are the entire interface this phase hands to the rest of the build.

## What Phase 0 IS

- A **standalone Node/TypeScript pipeline** (no RN, no Expo, no simulator) that:
  - fetches a fixed set of sports/tournaments from `api.psk.hr` and snapshots them to JSON
  - parses the provided CSVs into a small synthetic user profile
  - derives the Croatian market-name lexicon from real `marketTypeName` values
  - freezes all kickoff times onto a fixed "demo now" so the data looks live on any rehearsal date
- A **schema contract** (TypeScript interfaces) that Phase 2 (screens) and Phase 3 (tools) build against.
- A **repo-structure proposal** to confirm with the teammate before their Xcode/RN project and this pipeline need to know about each other.

## What Phase 0 IS NOT

- **No RN app code, no screens, no navigation.** That's Phase 2.
- **No Azure, no WebRTC, no voice.** That's Phase 1.
- **No Xcode, no native modules, no widgets.** That's the teammate's track / Phase 4.
- **No agent/tool logic, no confirmation gate.** That's Phase 3.
- **Not a live-fetch-at-demo-time system.** The pipeline runs once (and reruns on demand), the app only ever reads the committed output. A live-fetch debug toggle is a later, optional add-on — not built here.

## Repo layout decision

Until the teammate's RN project location is confirmed, this pipeline lives independently and is framework-agnostic:

```
E:\feg-hackathon\
  docs\                        (already exists)
  data-pipeline\
    src\
      fetchPsk.ts               PSK API client (sports, fixtures, markets, scoreboard)
      buildFixtures.ts          snapshot orchestrator → dist/fixtures.json, dist/markets.json
      buildLexicon.ts           dist/lexicon.json
      buildUserProfile.ts       CSV parser → dist/userProfile.json
      types.ts                  shared interfaces (see below)
      demoClock.ts              freezes/remaps kickoff times
    dist\
      fixtures.json
      markets.json
      lexicon.json
      userProfile.json
    package.json
```

Once the RN app repo exists, `dist/*.json` gets copied (or the pipeline's output path is pointed) into its `src/data/` — a one-line change, not a redesign. This keeps Phase 0 fully unblocked by not yet knowing where the Xcode project lives.

## Data decisions

**Sports/tournaments in the snapshot:** Football (a handful of real tournaments — Champions League, Eredivisie, one or two domestic leagues) plus Cricket, to match the two example sports named in the brief.

**The "India vs Australia" example:** this is the user's own headline scenario, so it must exist in the demo data even if PSK's live API has no such fixture scheduled at snapshot time. Decision: attempt to pull a real Kriket fixture first; if India vs Australia specifically isn't live, **hand-author one fixture matching the real API schema exactly** (same field shapes, same Croatian market names, plausible odds), and mark it `"isSynthetic": true`. Every other fixture is real, unmodified PSK data — this is the one deliberate exception, and it's flagged in the data itself so it's never presented as live.

**Demo clock:** all kickoff times get remapped relative to a frozen `DEMO_NOW` constant at build time (e.g., shift every fixture so kickoffs fall "in the next few hours" from whenever the snapshot was built), so the demo never shows stale "started 3 days ago" matches regardless of when it's rehearsed or presented.

**Rate limiting:** `robots.txt` sets `Crawl-delay: 20` — the fetcher sequences requests with that spacing, not parallel fan-out.

## Schema contract (draft — this is what later phases build against)

```ts
interface Fixture {
  id: string;                 // real "ufo:mtch:…" or "demo:mtch:…" for the synthetic one
  sportId: string; sportNameEn: string; sportNameHr: string;
  tournamentId: string; tournamentNameEn: string; tournamentNameHr: string;
  seoName: string;            // slug, what resolve_entity resolves
  home: { id: string; name: string };
  away: { id: string; name: string };
  kickoffUtc: string;         // ISO, already remapped onto the demo clock
  status: "SCHEDULED" | "LIVE" | "FINISHED";
  liveScore?: { home: number; away: number; gameTime?: string };
  marketIds: string[];
  isSynthetic: boolean;       // true only for the India vs Australia fixture, if needed
}

interface Market {
  id: string; fixtureId: string;
  marketTypeId: string; marketTypeNameHr: string;   // e.g. "Osnovna ponuda"
  outcomes: Array<{ id: string; name: string; odds: number; previousOdds?: number }>;
}

interface LexiconEntry {
  marketTypeNameHr: string;                  // key, matches Market.marketTypeNameHr
  canonicalMarket: string;                   // "1X2" | "OVER_UNDER" | "BTTS" | …
  englishLabel: string;                      // "Match Winner"
  outcomeLabelsEn: Record<string, string>;   // "1" -> "Home win", "Da" -> "Yes"
}

interface UserProfile {
  userId: string;                            // anonymised, from the CSVs
  favouriteTeams: string[];
  followedTournaments: string[];
  openTickets: Array<{ id: string; fixtureId: string; market: string; stake: number; potentialReturn: number }>;
  limits: { sessionStakeLimit: number; currency: "EUR" };
}
```

## Task breakdown

| # | Task | Output |
|---|---|---|
| 0.1 | Confirm repo boundary with teammate (this pipeline stands alone for now; where does it land once their RN project exists) | Decision recorded here |
| 0.2 | `fetchPsk.ts` — client for `/offer/structure/api/v1_0/sports`, `/widget/live/fixtures`, `/markets/api/v1_0/fixture/{id}/markets`, `/stats-v2/api/v2_0/fixture/{id}/scoreboard`, paced at Crawl-delay: 20 | reusable fetch client |
| 0.3 | `buildFixtures.ts` — selects tournaments, calls the client, normalizes into `Fixture`/`Market`, applies `demoClock.ts`, authors the India vs Australia fixture only if absent from the live pull | `dist/fixtures.json`, `dist/markets.json` |
| 0.4 | `buildLexicon.ts` — walks the snapshot's real `marketTypeNameHr` values, pairs each with a hand-written English label/canonical market | `dist/lexicon.json` |
| 0.5 | `buildUserProfile.ts` — proper CSV parser (embedded commas inside quoted fields in `EPS_Offers.csv` break naive splitting) over the provided player/event CSVs, anonymised, distilled to a handful of favourite teams / open tickets / limits | `dist/userProfile.json` |
| 0.6 | Small validation script asserting all four files parse and cross-reference correctly (every `Market.fixtureId` resolves, every `marketTypeNameHr` has a lexicon entry) | `npm run validate` passing |

## Acceptance criteria

- `npm run snapshot` in `data-pipeline/` regenerates all four `dist/*.json` files from a clean checkout (network + CSVs only), reproducibly.
- Every fixture in `fixtures.json` is real PSK data except the one flagged `isSynthetic` entry (only created if no live India–Australia fixture exists).
- `npm run validate` passes: no dangling `fixtureId` references, no market without a lexicon entry.
- No file in this phase imports React, React Native, or anything Xcode-related.

## Open items carried from the master plan

- Where the teammate's RN project actually lives (blocks nothing in Phase 0, blocks the *hookup* in Phase 2).
- Confirming India vs Australia cricket availability in the live PSK feed at snapshot time (resolved automatically per the rule in §Data decisions).

---

**Next action, pending your go-ahead:** implement 0.2–0.6 in `data-pipeline/`.
