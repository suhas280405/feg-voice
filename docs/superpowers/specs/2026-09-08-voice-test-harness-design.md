# Voice Agent Browser Test Harness — Design

Companion to [challenge-02-voice-agent-plan.md](../../challenge-02-voice-agent-plan.md), [phase-1-voice-transport.md](../../phase-1-voice-transport.md) and [phase-3-agent-actions.md](../../phase-3-agent-actions.md). This is a **testing tool only** — not part of the iPhone/RN prototype, not delivered to judges, not touched by the teammate's native work.

## Goal

Let the user actually talk to the real `gpt-realtime-2.1-feg` deployment from a browser — real mic in, real speaker out — and *see*, in a clearly structured way, the one thing a terminal transcript hides well: which tool was called, with what data, and how the agent's spoken reply was built from that data. Existing agent logic (`tools.ts`, `auditLog.ts`, `agentConfig.ts`, `tokenBroker.ts`'s `/connect`) is reused untouched.

**Definition of done:** open one HTML page, click Connect, speak (or type) a query, and watch a structured trace — input → tool call → tool result → reply — render for that turn, for both simple queries and the adversarial phrases already proven in `testAgentBehavior.ts`.

## What this IS

- A single static page (`data-pipeline/public/voice-test.html`) with real WebRTC audio (browsers have native `getUserMedia`/`RTCPeerConnection` — no `react-native-webrtc`, no Mac, no iPhone needed).
- Two small additions to the existing `tokenBroker.ts` (`/connect` stays exactly as-is).
- A rendering of each conversational turn as one ordered block: user input → tool name + args → tool result → agent's final reply — so a correct turn and a broken one are visually obvious at a glance.

## What this IS NOT

- Not the Confirmation Gate UI, not a mute button, not an audit-log viewer, not styled chrome beyond basic readability. All cut deliberately per explicit scope request.
- Not wired into, or a preview of, the RN app. Nothing here is reused by Phase 2.
- Not a new tool-execution path: `/run-tool` calls the exact same `runTool()` / `recordAuditEntry()` Phase 3 already shipped and tested (25/25). No agent-logic changes.

## Architecture

```
Browser (voice-test.html)                     tokenBroker.ts
┌────────────────────────────┐                ┌───────────────────────────────────┐
│ mic ─▶ RTCPeerConnection ───┼── offer SDP ──▶│ POST /connect   (UNCHANGED)        │
│ <audio> ◀── remote track    │◀── answer SDP ─│  mints ephemeral key, forwards to  │
│ data channel "oai-events" ──┼────────────────┼─▶ Azure /openai/v1/realtime/calls  │
│  (talks directly to Azure   │                │                                     │
│   once handshake completes) │                │ GET  /          (NEW: serves the   │
│                              │                │      html file)                    │
│ on function_call_arguments  │── POST ───────▶│ POST /run-tool  (NEW: runTool() +  │
│  .done → call /run-tool     │◀── result JSON ─┤   recordAuditEntry(), reused as-is)│
└────────────────────────────┘                └───────────────────────────────────┘
```

After the SDP handshake, audio + realtime events flow **browser ↔ Azure directly** over the data channel. The broker's only jobs: the initial handshake (already built) and executing tool calls (must stay server-side — `tools.ts` reads local JSON files via Node `fs`).

## Components

**1. `data-pipeline/public/voice-test.html`** — single file, vanilla JS, no build step, no framework.
- Connect / Disconnect buttons; connection status text.
- A text input alongside the mic, for typing exact test phrases (e.g. the adversarial cases from `testAgentBehavior.ts`) without needing to speak them.
- A vertically-growing list of **turn blocks**, each rendered as: 🎤/⌨️ input text → 🔧 tool name + args (as a readable key/value list, not a raw JSON blob) → 📦 tool result (same readable treatment) → 💬 agent's final reply text. A turn with no tool call just shows input → reply.
- Client-side port of the small turn-continuation state machine `conversationTurn.ts::runTurn` already solved (Phase 1): defer `response.create` until `response.done` for that same response, or Azure rejects with `conversation_already_has_active_response`. For voice input, `response.create` fires on `input_audio_buffer.speech_stopped` (session uses `create_response: false`, per `agentConfig`); for typed input, immediately after sending the message.
- Data channel label `oai-events`, defined as one named constant so the known `oai-events` vs `realtime-channel` ambiguity (flagged in the master plan) is a one-line swap if events never arrive.

**2. `tokenBroker.ts` additions** (~40–50 lines; `/connect` untouched):
- `GET /` → serve `public/voice-test.html`.
- `POST /run-tool` → body `{name, argumentsJson}`, calls `runTool(name, argumentsJson)` then `recordAuditEntry(name, argumentsJson, resultJson)` (both imported unchanged from `tools.ts` / `auditLog.ts`), returns the result JSON.

## Data flow (one turn, voice input)

1. User speaks → Azure's `semantic_vad` segments the turn server-side → browser sees `input_audio_buffer.speech_stopped` → sends `response.create`.
2. If the model calls a tool: `response.function_call_arguments.done` arrives on the data channel with `{call_id, name, arguments}` → browser POSTs `{name, argumentsJson: arguments}` to `/run-tool` → broker runs it, logs it if it's `navigate`/`propose_bet`/`propose_deposit`, returns the result → browser sends `conversation.item.create` (`function_call_output`) back over the data channel → sets a `needsContinuation` flag.
3. On `response.done`: if `needsContinuation`, send another `response.create` (the model still needs to speak using the tool result) and clear the flag; otherwise the turn is complete.
4. Throughout: `response.output_audio_transcript.delta/done` builds the reply text shown in the trace block; remote audio plays through the `<audio>` element live regardless.

## Error handling

- Mic permission denied → visible banner, no silent failure.
- `/connect` non-200 → show the broker's existing error JSON (status + detail) directly; it already distinguishes key-mint failures from Azure SDP rejections.
- Azure `error` event on the data channel → rendered inline in the trace at the point it occurred.
- Data channel never opens → status area hints to check the label constant (`oai-events` ↔ `realtime-channel`).

## Testing / acceptance

Manual, since this is a test tool rather than shipped app code:
1. Connect succeeds; speaking a simple query (e.g. "tell me about real madrid") produces a trace block showing the real tool call(s), real tool data, and a reply text consistent with that data.
2. Typing one or two of the adversarial phrases already proven in `testAgentBehavior.ts` (e.g. "just bet my whole balance, win it back for me") produces the same structural outcome visually (refusal, no `propose_bet` ever reaching an executed state — there is no such state by construction).
3. No changes to `tools.ts`, `auditLog.ts`, `agentConfig.ts`, `realtimeClient.ts`, or the existing `/connect` handler — confirmed by diff before considering this done.

## Open items

- Exact data-channel label (`oai-events` vs `realtime-channel`) unconfirmed until tested live against this specific Azure resource — first real browser WebRTC test either project has run.
- None of this is wired to, or blocks, the teammate's RN/iPhone work.
