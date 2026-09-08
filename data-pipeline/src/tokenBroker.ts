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
import { readFileSync } from "node:fs";
import { AGENT_CONFIG } from "./agentConfig.ts";
import { buildSessionUpdate } from "./realtimeClient.ts";

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

  // Step 2: forward the device's offer SDP to Azure, using the ephemeral key. ?webrtcfilter=on
  // keeps our system instructions server-side (see phase-1-voice-transport.md).
  const callsRes = await fetch(`${AZURE_ENDPOINT}/openai/v1/realtime/calls?webrtcfilter=on`, {
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

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
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
  console.log(`  GET  /health   — liveness check`);
  console.log(`  POST /connect  — body: raw SDP offer, Content-Type: application/sdp -> returns answer SDP`);
  console.log(`Expose to a phone with: ngrok http ${PORT}`);
});
