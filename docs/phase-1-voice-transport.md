# Phase 1 — Voice Transport

**Status: the Windows-buildable half is implemented and verified live against the real Azure deployment.** This document originally planned all six steps assuming a physical iPhone would be available throughout. It wasn't (Windows machine, no Mac) — so the plan changed, and this now records what was actually built. Steps 1, 5, 6 remain the teammate's, on his Mac and iPhone, unstarted. Companion to [phase-0-foundations.md](./phase-0-foundations.md) and [phase-3-agent-actions.md](./phase-3-agent-actions.md), pulled from Phase 1 of [challenge-02-voice-agent-plan.md](./challenge-02-voice-agent-plan.md).

## What changed from the original plan, and why

The single biggest change: **"mock transport" (canned, scripted responses) was replaced by a real text-mode connection to the actual Azure deployment.** Everything else below follows from that one decision, plus three concrete corrections found only by actually connecting.

| Planned | Built instead | Why |
|---|---|---|
| A "mock transport" — `MockRealtimeClient` playing back canned/scripted responses, no real Azure connection | **`RealtimeTextClient`** — a real WebSocket connection to the real `gpt-realtime-2.1-feg` deployment, text-only (no audio). Genuinely intelligent tool selection, not scripted. | A mock proves the UI can hold a conversation shape. This proves the *actual agent* works — real language understanding, real tool-calling decisions — using a transport (plain WebSocket, text) that needs zero WebRTC/RN/Mac/iPhone. Strictly more real for the same effort. |
| Separate `voice-transport` and `voice-broker` packages | **No new packages.** `realtimeClient.ts`, `realtimeTextClient.ts`, `chatCli.ts`, `tokenBroker.ts` all live in the existing `data-pipeline/src/` | Same lesson as Phase 3: nothing outside `data-pipeline` exists yet to justify a package boundary. `chatCli.ts` needs to import `tools.ts`'s `runTool` directly — trivial in one package, friction across two. |
| `setMuted()` on the `RealtimeClient` interface | **Not included.** | Audio-specific; meaningless for a text client. Added when the WebRTC client that actually needs it gets built — not speculatively now. |

Three corrections, found only by connecting to the real endpoint rather than trusting the written protocol notes:

1. **The GA WebSocket endpoint requires `?model=<deployment>` in the query string** — Azure returns `400 OperationNotSupported: "requires either model=<deployment-id> or intent=transcription"` without it. The original doc's blanket "no query param anywhere" was true for the WebRTC `/calls`/`/client_secrets` endpoints (confirmed earlier) but not for the WebSocket endpoint — a real gap between two similar-looking GA endpoints.
2. **A response containing a function call is "done" before its result is available.** `response.function_call_arguments.done` fires, then later `response.done` — for *that same response*. Sending the continuation `response.create` reacting to the tool-call event (rather than waiting for that response's own `response.done`) races Azure and gets rejected: `"conversation_already_has_active_response"`. Reproduced directly, then fixed with a `needsContinuation` flag that defers the follow-up `response.create` to the right event.
3. **A `while (true) await rl.question()` loop is unsafe with piped/scripted input.** Node's readline can hit EOF and auto-close while a response is still being awaited, throwing `ERR_USE_AFTER_CLOSE` on the next call. Fixed by queueing lines via the `line` event instead of asking for them synchronously — the same code path now handles a human typing and a fully piped test script correctly.

## Follow-up: closing gaps found once the above was live (agentConfig, precision testing, audit log)

Three more tasks, done after the above was already working, prompted by one explicit standing principle: **the agent must do exactly what it's told — not more, not less.** That's not new (it's been the design since Phase 3's tool contracts), but it hadn't yet been *tested* as a property, only built as one. This pass tested it, and found a real gap.

**1. `agentConfig.ts` — one canonical instructions + tool-schema source.** Found first: `tokenBroker.ts` minted ephemeral keys with no instructions or tools embedded at all — only `chatCli.ts` set them, client-side. That defeated the actual point of `?webrtcfilter=on` (keeping instructions server-side), which the original doc already called out but hadn't been enforced. Fixed by extracting `AGENT_CONFIG` (instructions + `TOOL_SCHEMAS` + `tool_choice`) into one file, used by both `chatCli.ts` and `tokenBroker.ts`'s `client_secrets` call (via `buildSessionUpdate`, reused rather than a second hand-written copy of the session shape). One place for the teammate's eventual iOS client to match behavior against, too.

**2. `testAgentBehavior.ts` — a live, adversarial precision suite.** `testTools.ts` proves *our code* is correct; this proves the *model's actual behavior* is, which is a different and non-deterministic thing to test. Every hard assertion is structural (which tools got called, with what arguments) rather than pattern-matching the model's prose — the only way to get a reliable pass/fail on an LLM. 8 live cases across: never guessing on ambiguous input, never inventing a stake, never triggering a side-effecting tool on a pure question, fully completing a clear valid request, the code-level refusal actually engaging on an excessive stake, and a structural allowlist check that no `confirm_*`/`execute_*` tool exists in the live schema.

Building it immediately surfaced a real bug, not a hypothetical one: the model was defaulting to `search_fixtures({when: "upcoming"})` on ordinary team-name lookups, which silently excludes *live* matches — on a fully-specified, otherwise-completable bet request, this caused a false "fixture not found" and the agent asked an unnecessary clarifying question instead of completing the request. That's a genuine "less than asked" violation. Root cause was the tool schema's `when` description not warning against unprompted use — fixed there (not in the model prompt, not with handler logic), rerun, **8/8 passing**. Extracting `conversationTurn.ts::runTurn` (the same turn-continuation state machine `chatCli.ts` uses) was a prerequisite — this suite could not have been built correctly without it, and duplicating that logic a second time was exactly the risk worth avoiding.

**3. `auditLog.ts` — the Confirmation Gate's audit trail, actually implemented.** The master plan promised one; it didn't exist until now. Deliberately scoped to only `navigate`/`propose_bet`/`propose_deposit` (an explicit allowlist) — Tier 1 reads aren't compliance-relevant the same way, and logging them would be scope creep past what was actually promised. One JSONL line per call, timestamp + args + result. It does **not** live inside `tools.ts`/`runTool` — that module is documented and tested as side-effect-free, and adding a file write there would have silently broken an already-verified property. It hooks into `conversationTurn.ts::runTurn` instead, the one real choke point every transport already shares. Verified against a real run: exactly the 2 side-effecting calls that happened were logged, in order, with valid timestamps and parseable JSON — and none of the read-only calls in the same conversation were.

```
data-pipeline\src\
  agentConfig.ts        AGENT_CONFIG: instructions + TOOL_SCHEMAS + tool_choice — one source of truth
  conversationTurn.ts   runTurn() + connectWithRetry() + waitForSessionReady() — shared by chatCli.ts and testAgentBehavior.ts
  auditLog.ts           recordAuditEntry() / readAuditLog() — JSONL, scoped to Tier 2/3 only
  testAgentBehavior.ts  8 live adversarial cases, structural assertions only
```

One more fix along the way: a transient DNS blip (same host, one-off — seen once before, earlier this session) crashed the whole test suite via an unhandled promise rejection on a bare `await client.connect()`. `connectWithRetry()` (one retry, then propagate) now guards this in both `chatCli.ts` and `testAgentBehavior.ts`.

## Goal (adjusted)

Originally: prove voice works end-to-end on a physical iPhone. Adjusted, given the Windows/no-Mac constraint: prove the **agent** — real Azure model, real tool-calling, real safety contract — works end-to-end from a terminal, with **zero** dependency on RN/WebRTC/Mac/iPhone, while leaving the audio/mobile transport as a well-specified, independently-buildable piece for the teammate.

## What was actually built

```
data-pipeline\src\
  realtimeClient.ts       RealtimeClient interface + buildSessionUpdate() + GA_EVENTS constants
  realtimeTextClient.ts   WebSocket, text-only, direct API-key auth — verified live
  chatCli.ts              interactive terminal chat against the real deployment, wired to tools.ts
  tokenBroker.ts          the SDP-proxy server for the eventual mobile/WebRTC path
```

`ws` + `@types/ws` added as the one new dependency (Node's native `fetch`-adjacent global `WebSocket` can't send the custom `api-key` header this needs).

### Live verification — the actual demo scenario, run for real

```
$ npm run chat
Connected. Type a message (or 'exit').

you> tell me about real madrid
agent> I'll pull up any current fixtures involving Real Madrid...
  [tool call]   search_fixtures({"query":"Real Madrid","sport":"Football"})
  [tool call]   get_fixture_details({"fixtureId":"ufo:mtch:1vu-03k"})
agent> Real Madrid are currently in a Champions League match against Inter M., and it's live. The score is 0–0.

you> put 10 on real madrid to win
agent> Got it — I'll set up a bet proposal for Real Madrid to win so you can review it in the app.
  [tool call]   propose_bet({"fixtureId":"ufo:mtch:1vu-03k","market":"Match Winner","selection":"Home","stake":10})
agent> Your bet proposal is ready for review: Real Madrid to win (Match Winner), stake 10 EUR at odds 1.65,
       potential return 16.5 EUR. It's awaiting your confirmation in the betslip — nothing is placed until
       you tap to confirm.

you> put 10000 on real madrid to win
agent> [tool call]   propose_bet({"fixtureId":"ufo:mtch:1vu-03k","market":"Match Winner","selection":"Home","stake":10000})
       -> {"status":"refused","reason":"over_session_limit","message":"That stake exceeds the session limit of 60 EUR.", ...}
agent> I can't prepare that bet because it was refused: the stake exceeds your session limit of 60 EUR.
       If you'd like, I can navigate you to the responsible gaming page to review your limits.
```

Nothing in that transcript is scripted. The model chose which tools to call, in which order, from a one-line English instruction — and, without being told to say it in those words, independently framed the successful proposal as "nothing is placed until you tap to confirm" and the refused one by explaining the limit and offering (not forcing) a next step. That is the confirmation-layer promise from the very first message of this project, demonstrated rather than merely built.

### Token broker — verified as far as Windows can verify it

```
$ npm run broker
Token broker listening on http://localhost:8787

$ curl -X POST localhost:8787/connect -H "Content-Type: application/sdp" --data-binary "<fake SDP>"
{"error":"Azure rejected the SDP offer","status":400,
 "detail":"{\"error\":{\"message\":\"Failed to parse offer: failed to unmarshal SDP: EOF\", ...}}"}
```

That 400 is Azure correctly rejecting a *deliberately fake* SDP body — which proves the broker minted a real ephemeral key and successfully reached Azure's real `/calls` endpoint with it. The one thing this can't verify is a *valid* SDP producing a valid answer, because that requires an actual WebRTC peer connection, which only exists on a real device. That's exactly where steps 1/5/6 pick up.

## What Phase 1 IS

- A real, working, terminal-based conversation with `gpt-realtime-2.1-feg`, tool-calling included, requiring nothing beyond Node and the already-verified `.env` credentials.
- A token broker whose entire non-device-dependent logic (key minting, SDP forwarding, error handling) is verified against the real Azure endpoint.
- A `RealtimeClient` interface that the eventual WebRTC implementation will also satisfy, so nothing above this layer needs to change when it arrives.
- Three real protocol corrections (the query param, the response-completion race, the readline EOF race) found and fixed by actually running the code against the real service — not left for the teammate to discover independently on a device, which would have cost far more time there than here.

## What Phase 1 IS NOT

- **Not audio.** No `react-native-webrtc`, no mic, no speaker anywhere in this code. That's steps 1/5/6, entirely the teammate's, on his Mac and iPhone.
- **Not wired into the RN app.** `chatCli.ts` is a terminal tool, not a screen. The interface (`realtimeClient.ts`) is what a real RN integration will implement against, but no RN code exists yet.
- **Not a production broker.** No auth beyond holding the one Azure key, no multi-tenant support — enough to unblock a device reaching it via a tunnel, no more.

## Steps 1, 5, 6 — unchanged, still entirely the teammate's

| # | Step | Status |
|---|---|---|
| 1 | Native spike — `react-native-webrtc` 124.0.8 on RN 0.87, physical iPhone | Not started. Teammate has both a Mac and an iPhone (confirmed). Highest-priority item once his project's file path is known. |
| 5 | Real `WebRtcRealtimeClient`, implementing the same `RealtimeClient` interface `realtimeTextClient.ts` already implements | Not started — blocked on step 1. |
| 6 | On-device end-to-end voice verification | Not started — blocked on step 5. |

The RN wiring notes (registerGlobals, AVAudioSession contention, InCallManager speaker routing, Info.plist, the New-Architecture/bridgeless risk given RN 0.87 has no legacy-bridge fallback) from the original plan are unchanged and still the right reference for whoever runs step 1 — not repeated here, see git history of this file or the master plan for the full detail if needed.

## Open items

- **Teammate's RN project file path** — still the only thing blocking steps 1/5/6. Everything else Phase 1 needed from him (Mac, iPhone) is confirmed available.
- **Token broker hosting for the on-device test** — decided: local machine + ngrok tunnel. Not yet set up (no device to test against yet).
- **`gpt-realtime-2.1` not in Microsoft's published model list** — moot in practice: confirmed working live against the real deployment regardless of what the docs list.
