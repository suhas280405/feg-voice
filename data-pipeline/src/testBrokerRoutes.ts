/**
 * Automated test for tokenBroker.ts's two new routes (GET /, POST /run-tool)
 * added for the browser voice test harness — see
 * docs/superpowers/specs/2026-09-08-voice-test-harness-design.md.
 *
 * Spawns the real broker as a child process on a dedicated test port (so it
 * never collides with a broker already running on 8787), waits for /health,
 * exercises the new routes with real HTTP requests, then kills it. Same
 * plain check()/process.exitCode style as testTools.ts. Makes zero real
 * Azure calls — /run-tool never touches the network, only /connect does,
 * and this test never calls /connect.
 *
 * Usage:
 *   npx tsx src/testBrokerRoutes.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readAuditLog } from "./auditLog.ts";

const TEST_PORT = 8799;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let failures = 0;
function check(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.error(`  PASS  ${description}`);
  } else {
    failures++;
    console.error(`  FAIL  ${description}${detail ? ` — ${detail}` : ""}`);
  }
}

function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.ok) return resolve();
      } catch {
        // broker not listening yet — keep polling
      }
      if (Date.now() > deadline) return reject(new Error("broker did not become healthy in time"));
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

async function main(): Promise<void> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "src/tokenBroker.ts"],
    {
      // Spawning node directly (not `npx tsx`) avoids a Windows-specific
      // gotcha: npx runs through a shell wrapper, and killing that shell
      // later does not reliably kill the real node process underneath it,
      // leaking a process still holding TEST_PORT.
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForHealth(10_000);

    console.error("--- GET / ---");
    const homeRes = await fetch(`${BASE_URL}/`);
    const homeBody = await homeRes.text();
    check("GET / returns 200", homeRes.status === 200, `got ${homeRes.status}`);
    check(
      "GET / returns html content-type",
      (homeRes.headers.get("content-type") ?? "").includes("text/html"),
      homeRes.headers.get("content-type") ?? "(none)",
    );
    check("GET / body contains the page title", homeBody.includes("Voice Agent Test Harness"));

    console.error("\n--- POST /run-tool (Tier 1: search_fixtures) ---");
    const searchRes = await fetch(`${BASE_URL}/run-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "search_fixtures", argumentsJson: JSON.stringify({ query: "Real Madrid" }) }),
    });
    const searchBody = (await searchRes.json()) as { matches?: unknown[] };
    check("POST /run-tool returns 200 for a known tool", searchRes.status === 200, `got ${searchRes.status}`);
    check(
      "POST /run-tool result matches runTool's own shape (a matches[] array)",
      Array.isArray(searchBody.matches) && searchBody.matches.length === 1,
      JSON.stringify(searchBody),
    );

    console.error("\n--- POST /run-tool (Tier 2: navigate, must audit-log) ---");
    const beforeCount = readAuditLog().length;
    const navRes = await fetch(`${BASE_URL}/run-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "navigate", argumentsJson: JSON.stringify({ screen: "homepage" }) }),
    });
    check("POST /run-tool returns 200 for navigate", navRes.status === 200, `got ${navRes.status}`);
    const afterCount = readAuditLog().length;
    check(
      "navigate call appended exactly one audit log entry",
      afterCount === beforeCount + 1,
      `before=${beforeCount} after=${afterCount}`,
    );

    console.error("\n--- POST /run-tool (unknown tool name) ---");
    const badRes = await fetch(`${BASE_URL}/run-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "does_not_exist", argumentsJson: "{}" }),
    });
    const badBody = (await badRes.json()) as { error?: string };
    check(
      "unknown tool name returns a structured error, not a crash",
      badRes.status === 200 && typeof badBody.error === "string",
      JSON.stringify(badBody),
    );
  } finally {
    child.kill();
  }

  console.error(`\n${failures === 0 ? "OK" : "FAILED"}: ${failures} failure(s).`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
