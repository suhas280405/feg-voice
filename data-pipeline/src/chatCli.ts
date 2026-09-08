/**
 * Interactive text-mode CLI against the real Azure gpt-realtime-2.1-feg
 * deployment (Phase 1 — see docs/phase-1-voice-transport.md).
 *
 * Type what a user would say; watch the model's real replies and real tool
 * calls (routed through tools.ts's runTool, Phase 3) happen live. Fully
 * verifiable from Windows — zero RN, zero WebRTC, zero Mac/iPhone
 * dependency, because it never touches audio at all.
 *
 * The actual turn-handling logic lives in conversationTurn.ts, shared with
 * testAgentBehavior.ts — this file only adds interactive printing on top.
 *
 * Usage: npx tsx src/chatCli.ts
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { AGENT_CONFIG } from "./agentConfig.ts";
import { connectWithRetry, runTurn, waitForSessionReady } from "./conversationTurn.ts";
import { buildSessionUpdate } from "./realtimeClient.ts";
import { RealtimeTextClient } from "./realtimeTextClient.ts";

function loadEnv(): Record<string, string> {
  const content = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    vars[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
  }
  return vars;
}

async function main() {
  const env = loadEnv();
  if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_API_KEY || !env.AZURE_OPENAI_REALTIME_DEPLOYMENT) {
    console.error("Missing AZURE_OPENAI_* values in .env — see .env.example.");
    process.exit(1);
  }

  const client = new RealtimeTextClient({
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    apiKey: env.AZURE_OPENAI_API_KEY,
    deployment: env.AZURE_OPENAI_REALTIME_DEPLOYMENT,
  });

  console.error("Connecting to Azure Realtime (text mode)...");
  await connectWithRetry(client, (err) =>
    console.error(`  connection attempt failed (${err instanceof Error ? err.message : String(err)}), retrying once...`),
  );

  client.sendEvent(
    buildSessionUpdate({
      model: env.AZURE_OPENAI_REALTIME_DEPLOYMENT,
      instructions: AGENT_CONFIG.instructions,
      outputModalities: ["text"],
      tools: AGENT_CONFIG.tools,
    }),
  );
  await waitForSessionReady(client);

  console.error("Connected. Try: \"what's on in the champions league tonight\", \"tell me about india vs australia\",");
  console.error("\"put 20 on australia\", \"put 10000 on real madrid\". Type 'exit' to quit.\n");

  // A plain `while (true) await rl.question(...)` races: with piped/scripted
  // input, all lines can arrive before the first response finishes, and
  // readline auto-closes on EOF while this loop is still `await`-ing the
  // response — throwing ERR_USE_AFTER_CLOSE on the next question() call.
  // Queueing lines via the "line" event instead handles both a human typing
  // at a human pace and a fully piped script correctly, with the same code.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const inputQueue: string[] = [];
  let waitingForInput: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on("line", (line) => {
    if (waitingForInput) {
      const resolve = waitingForInput;
      waitingForInput = null;
      resolve(line);
    } else {
      inputQueue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    waitingForInput?.(null);
    waitingForInput = null;
  });

  function nextLine(): Promise<string | null> {
    if (inputQueue.length > 0) return Promise.resolve(inputQueue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waitingForInput = resolve;
    });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    process.stdout.write("you> ");
    const line = await nextLine();
    if (line === null) break; // stdin closed (EOF) — equivalent to the user having nothing more to say
    if (line.trim().toLowerCase() === "exit") break;
    if (!line.trim()) continue;

    let streaming = false;
    await runTurn(client, line, {
      onTextDelta: (delta) => {
        if (!streaming) {
          process.stdout.write("\nagent> ");
          streaming = true;
        }
        process.stdout.write(delta);
      },
      onToolCall: ({ name, argsJson, resultJson }) => {
        if (streaming) {
          process.stdout.write("\n");
          streaming = false;
        }
        console.log(`  [tool call]   ${name}(${argsJson})`);
        console.log(`  [tool result] ${resultJson}`);
      },
      onServerError: (evt) => {
        if (streaming) process.stdout.write("\n");
        console.error("\n[server error]", JSON.stringify(evt));
      },
    });
    if (streaming) process.stdout.write("\n");
  }

  rl.close();
  client.disconnect();
  process.exit(0);
}

await main();
