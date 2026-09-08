/**
 * Token broker — proxies the WebRTC SDP exchange so a mobile device never
 * holds the real Azure API key (Phase 1 — see docs/phase-1-voice-transport.md).
 *
 * The device POSTs its offer SDP to /connect; this mints an ephemeral key
 * server-side, forwards the offer to Azure's /calls endpoint, and returns
 * the answer SDP. Run locally and expose via a tunnel (e.g. ngrok) so a
 * physical iPhone can reach it during testing — this was the explicit
 * hosting decision for now (see docs/phase-1-voice-transport.md open items).
 *
 * Usage:
 *   npx tsx src/tokenBroker.ts
 *   ngrok http 8787   (separately, to expose it to a phone)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { AGENT_CONFIG } from "./agentConfig.ts";
import { buildSessionUpdate } from "./realtimeClient.ts";
import { runTool } from "./tools.ts";
import { recordAuditEntry } from "./auditLog.ts";

const PUBLIC_HTML_PATH = new URL("../public/voice-test.html", import.meta.url);

// Live debugging of the browser client (public/voice-test.html) otherwise
// depends on someone manually copy-pasting the browser console — slow and
// lossy across a debugging session. The page instead POSTs every data-channel
// event it sends/receives here, so the whole realtime event trace is a plain
// file this side can read directly. Separate from auditLog.ts's Tier-2/3
// compliance log (a different, deliberately-scoped concern) — this is raw,
// unfiltered client debugging output, not an audit trail.
const CLIENT_LOG_PATH = fileURLToPath(new URL("../logs/client-events.log", import.meta.url));

function handleClientLog(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return readBody(req).then((bodyText) => {
    const dir = dirname(CLIENT_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Best-effort: still record malformed bodies rather than dropping them —
    // a garbled line in a debug log is still more useful than a silent gap.
    const line = JSON.stringify({ receivedAt: new Date().toISOString(), raw: bodyText });
    appendFileSync(CLIENT_LOG_PATH, `${line}\n`, "utf8");
    res.writeHead(204);
    res.end();
  });
}

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const env = loadEnv();
if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_API_KEY || !env.AZURE_OPENAI_REALTIME_DEPLOYMENT) {
  console.error("Missing AZURE_OPENAI_* values in .env — see .env.example.");
  process.exit(1);
}
// Re-bound as definitely-string locals: noUncheckedIndexedAccess means TS
// can't carry the validation above across into handleConnect() below, which
// reads these again later.
const AZURE_ENDPOINT: string = env.AZURE_OPENAI_ENDPOINT;
const AZURE_API_KEY: string = env.AZURE_OPENAI_API_KEY;
const AZURE_DEPLOYMENT: string = env.AZURE_OPENAI_REALTIME_DEPLOYMENT;

const PORT = Number(process.env.PORT ?? 8787);

async function handleConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const offerSdp = await readBody(req);
  if (!offerSdp.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Empty request body — expected a raw SDP offer." }));
    return;
  }

  // Step 1: mint a short-lived ephemeral key server-side, with the agent's
  // instructions and tools already baked in via AGENT_CONFIG (reusing
  // buildSessionUpdate so this session shape never drifts from chatCli.ts's).
  // This is what makes "?webrtcfilter=on keeps instructions server-side"
  // actually true — previously this call minted a bare key with no
  // instructions/tools at all, leaving the device to set them itself,
  // which defeated the point.
  const { session } = buildSessionUpdate({
    model: AZURE_DEPLOYMENT,
    instructions: AGENT_CONFIG.instructions,
    outputModalities: ["audio"],
    tools: AGENT_CONFIG.tools,
  });
  const secretRes = await fetch(`${AZURE_ENDPOINT}/openai/v1/realtime/client_secrets`, {
    method: "POST",
    headers: { "api-key": AZURE_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ session }),
  });
  if (!secretRes.ok) {
    const detail = await secretRes.text();
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to mint ephemeral key", status: secretRes.status, detail }));
    return;
  }
  const { value: ephemeralKey } = (await secretRes.json()) as { value: string };

  // Step 2: forward the device's offer SDP to Azure, using the ephemeral key.
  //
  // DIAGNOSTIC: webrtcfilter=on temporarily disabled. Live testing showed a
  // response fully generate and play its audio (response.output_audio_transcript.done,
  // output_audio_buffer.stopped both fire) and then go completely silent —
  // no function_call_arguments.done, no response.done, ever — until our own
  // client-side watchdog gives up. webrtcfilter's documented job is exactly
  // "restricts which events reach the device" (see docs/challenge-02-voice-agent-plan.md),
  // making it a direct, testable candidate for events being silently dropped.
  // Set WEBRTC_FILTER=on in .env to restore it once this is confirmed either
  // way — do not remove this permanently without knowing the answer, since
  // it is also what keeps the system prompt off the client for a real deploy.
  const webrtcFilterParam = env.WEBRTC_FILTER === "on" ? "?webrtcfilter=on" : "";
  const callsRes = await fetch(`${AZURE_ENDPOINT}/openai/v1/realtime/calls${webrtcFilterParam}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
    body: offerSdp,
  });
  if (!callsRes.ok) {
    const detail = await callsRes.text();
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Azure rejected the SDP offer", status: callsRes.status, detail }));
    return;
  }
  const answerSdp = await callsRes.text();
  // Captured for a future observer WebSocket (Phase 3's audit trail) — not used yet.
  const location = callsRes.headers.get("location");

  res.writeHead(200, {
    "Content-Type": "application/sdp",
    ...(location ? { "X-Realtime-Call-Location": location } : {}),
  });
  res.end(answerSdp);
}

function handleHome(_req: IncomingMessage, res: ServerResponse): void {
  const html = readFileSync(PUBLIC_HTML_PATH, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleRunTool(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyText = await readBody(req);
  let parsed: { name?: unknown; argumentsJson?: unknown };
  try {
    parsed = JSON.parse(bodyText || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Malformed JSON body — expected {name, argumentsJson}." }));
    return;
  }

  if (typeof parsed.name !== "string" || typeof parsed.argumentsJson !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body must be {name: string, argumentsJson: string}." }));
    return;
  }

  // runTool() never throws — it always returns a JSON string, even for an
  // unknown tool name or malformed arguments (see tools.ts). recordAuditEntry
  // is a no-op for any tool not in its explicit allowlist (Tier 1 reads).
  const resultJson = runTool(parsed.name, parsed.argumentsJson);
  recordAuditEntry(parsed.name, parsed.argumentsJson, resultJson);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(resultJson);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    handleHome(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/client-log") {
    handleClientLog(req, res).catch((err) => {
      console.error("[/client-log] unexpected error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal broker error" }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/run-tool") {
    handleRunTool(req, res).catch((err) => {
      console.error("[/run-tool] unexpected error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal broker error" }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/connect") {
    handleConnect(req, res).catch((err) => {
      console.error("[/connect] unexpected error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal broker error" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`Token broker listening on http://localhost:${PORT}`);
  console.log(`  GET  /          — voice test harness (open this in a browser)`);
  console.log(`  GET  /health    — liveness check`);
  console.log(`  POST /connect   — body: raw SDP offer, Content-Type: application/sdp -> returns answer SDP`);
  console.log(`  POST /run-tool  — body: {name, argumentsJson} -> runs the tool, returns its JSON result`);
  console.log(`  POST /client-log — body: any JSON -> appended to logs/client-events.log for server-side debugging`);
  console.log(`Expose to a phone with: ngrok http ${PORT}`);
});
