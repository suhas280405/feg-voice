/**
 * Lexicon builder — step 4 of Phase 0 (see docs/phase-0-foundations.md).
 *
 * Reads dist/markets.json (written by buildFixtures.ts — run that first)
 * and writes dist/lexicon.json: one LexiconEntry per distinct market type
 * actually present in the snapshot, each carrying literal translations for
 * every outcome name that market type actually uses.
 *
 * Deliberately builds FROM the snapshot rather than a market list PSK could
 * theoretically return — an unmapped market or outcome in real, curated
 * data is a bug we want to catch at build time (this script fails loudly),
 * not a runtime "ask_clarification" case Phase 3 has to paper over.
 *
 * Usage:
 *   npx tsx src/buildFixtures.ts   (first, produces dist/markets.json)
 *   npx tsx src/buildLexicon.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import type { LexiconEntry, Market } from "./types.ts";

// ---------------------------------------------------------------------------
// Market-type metadata: hand-authored, one entry per marketTypeNameHr we
// have actually observed. Adding a new tournament to buildFixtures.ts that
// introduces a new market type means adding one line here — the script
// below fails the build with a clear message if it does not.
// ---------------------------------------------------------------------------

interface MarketMeta {
  canonicalMarket: string;
  englishLabel: string;
}

const MARKET_META: Record<string, MarketMeta> = {
  "Osnovna ponuda": { canonicalMarket: "1X2", englishLabel: "Match Winner" },
  "Osnovna ponuda dvoznak": { canonicalMarket: "DOUBLE_CHANCE", englishLabel: "Double Chance" },
  "Ishod bez neriješenog": { canonicalMarket: "DRAW_NO_BET", englishLabel: "Draw No Bet" },
  "Zbroj golova": { canonicalMarket: "OVER_UNDER", englishLabel: "Total Goals" },
  "Tim 1 zbroj golova": { canonicalMarket: "TEAM_OVER_UNDER", englishLabel: "Home Team – Total Goals" },
  "Tim 2 zbroj golova": { canonicalMarket: "TEAM_OVER_UNDER", englishLabel: "Away Team – Total Goals" },
  "Oba daju gol": { canonicalMarket: "BTTS", englishLabel: "Both Teams to Score" },
  "Oba daju gol i zbroj golova": { canonicalMarket: "BTTS_OVER_UNDER", englishLabel: "Both Teams to Score & Total Goals" },
  "1.poluvrijeme": { canonicalMarket: "HALF_TIME_1X2", englishLabel: "1st Half – Result" },
  "1.poluvrijeme zbroj golova": { canonicalMarket: "HALF_TIME_OVER_UNDER", englishLabel: "1st Half – Total Goals" },
  "Poluvrijeme ili kraj": { canonicalMarket: "HALF_TIME_FULL_TIME", englishLabel: "Half Time / Full Time" },
  // Cricket has no draw, so PSK uses a distinct market type from football's 1X2.
  "Konačni pobjednik": { canonicalMarket: "MATCH_WINNER_NO_DRAW", englishLabel: "Match Winner" },
};

// ---------------------------------------------------------------------------
// Outcome vocabulary: stable, market-independent word/token meanings.
// "1"/"X"/"2" follow universal 1X2 betting convention (home/draw/away);
// "Tim 1"/"Tim 2" markets pair with that same convention (home/away).
// ---------------------------------------------------------------------------

const OUTCOME_TOKEN_EN: Record<string, string> = {
  "1": "Home",
  X: "Draw",
  "2": "Away",
  "1X": "Home or Draw",
  X2: "Draw or Away",
  "12": "Home or Away",
  Da: "Yes",
  Ne: "No",
  manje: "Under",
  više: "Over",
};

/**
 * Translates one outcome name using the token table above. Handles plain
 * tokens ("1" -> "Home"), numeric lines ("manje 2.5" -> "Under 2.5"), and
 * compound outcomes ("Da/manje 2.5" -> "Yes & Under 2.5"). Throws if any
 * word-token isn't recognized, so an outcome shape we haven't seen before
 * fails the build instead of shipping a partially-translated label.
 */
function translateOutcomeName(name: string): string {
  return name
    .split("/")
    .map((segment) =>
      segment
        .trim()
        .split(/\s+/)
        .map((word) => {
          if (word in OUTCOME_TOKEN_EN) return OUTCOME_TOKEN_EN[word];
          if (/^\d+(\.\d+)?$/.test(word)) return word; // a betting line, e.g. "2.5" — passes through
          throw new Error(
            `Unrecognized outcome token "${word}" in outcome name "${name}". Add it to OUTCOME_TOKEN_EN in buildLexicon.ts.`,
          );
        })
        .join(" "),
    )
    .join(" & ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const marketsUrl = new URL("../dist/markets.json", import.meta.url);
  const markets: Market[] = JSON.parse(await readFile(marketsUrl, "utf8"));
  if (markets.length === 0) {
    throw new Error("dist/markets.json is empty — run buildFixtures.ts first.");
  }

  const outcomesByMarketType = new Map<string, Set<string>>();
  for (const market of markets) {
    const set = outcomesByMarketType.get(market.marketTypeNameHr) ?? new Set<string>();
    for (const outcome of market.outcomes) set.add(outcome.name);
    outcomesByMarketType.set(market.marketTypeNameHr, set);
  }

  const entries: LexiconEntry[] = [];
  const missingMeta: string[] = [];

  for (const [marketTypeNameHr, outcomeNames] of outcomesByMarketType) {
    const meta = MARKET_META[marketTypeNameHr];
    if (!meta) {
      missingMeta.push(marketTypeNameHr);
      continue;
    }
    const outcomeLabelsEn: Record<string, string> = {};
    for (const outcomeName of outcomeNames) {
      outcomeLabelsEn[outcomeName] = translateOutcomeName(outcomeName);
    }
    entries.push({
      marketTypeNameHr,
      canonicalMarket: meta.canonicalMarket,
      englishLabel: meta.englishLabel,
      outcomeLabelsEn,
    });
  }

  if (missingMeta.length > 0) {
    throw new Error(
      `dist/markets.json contains market type(s) with no MARKET_META entry in buildLexicon.ts: ${missingMeta
        .map((n) => JSON.stringify(n))
        .join(", ")}. Add each one before the lexicon can be built.`,
    );
  }

  entries.sort((a, b) => a.marketTypeNameHr.localeCompare(b.marketTypeNameHr));

  const lexiconUrl = new URL("../dist/lexicon.json", import.meta.url);
  await writeFile(lexiconUrl, JSON.stringify(entries, null, 2) + "\n", "utf8");

  const totalOutcomes = entries.reduce((sum, e) => sum + Object.keys(e.outcomeLabelsEn).length, 0);
  console.error(
    `Done. ${entries.length} market types, ${totalOutcomes} translated outcome labels written to dist/lexicon.json.`,
  );
}

await main();
