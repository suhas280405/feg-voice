/**
 * Structured audit trail for every side-effecting agent action — the
 * Confirmation Gate's "logs every proposal and its outcome" promise from
 * the master plan, made real. Scoped deliberately to navigate/propose_bet/
 * propose_deposit only: Tier 1 reads (search_fixtures, get_odds, ...) are
 * not compliance-relevant the same way and logging them would be scope
 * creep past what was actually promised.
 *
 * One JSON object per line (JSONL) appended to logs/audit.log — easy to
 * append, easy to grep, easy to read back. This is the log Phase 2's
 * on-screen audit trail will eventually read from; it does not exist yet.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PATH = fileURLToPath(new URL("../logs/audit.log", import.meta.url));

export interface AuditEntry {
  timestamp: string;
  tool: string;
  argsJson: string;
  resultJson: string;
}

/** The only three tools this module ever logs — kept as an explicit allowlist, not inferred, so the scope stays deliberate. */
export const AUDITED_TOOLS = new Set(["navigate", "propose_bet", "propose_deposit"]);

export function recordAuditEntry(tool: string, argsJson: string, resultJson: string): void {
  if (!AUDITED_TOOLS.has(tool)) return;
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry: AuditEntry = { timestamp: new Date().toISOString(), tool, argsJson, resultJson };
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Returns [] if the log doesn't exist yet — no entries logged is a valid, common state, not an error. */
export function readAuditLog(): AuditEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  const content = readFileSync(LOG_PATH, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AuditEntry);
}
