# Integration Guide — plugging the RN/iOS app into what's already built

For whoever picks up the native side. Read this before writing any Swift/RN code — it tells you exactly what to implement, what to reuse verbatim, and one architectural decision you need to make that nothing here can make for you.

Everything referenced below lives in `data-pipeline/` at the repo root (companion to [phase-0-foundations.md](./phase-0-foundations.md), [phase-1-voice-transport.md](./phase-1-voice-transport.md), [phase-3-agent-actions.md](./phase-3-agent-actions.md) — those explain *why*; this explains *how to plug in*).

## What already exists, verified live against the real Azure deployment

- **The data**: `data-pipeline/dist/{fixtures,markets,lexicon,userProfile}.json` — committed, deterministic, real PSK data plus one flagged synthetic fixture.
- **The agent's identity**: `data-pipeline/src/agentConfig.ts` — `AGENT_CONFIG.instructions` + `AGENT_CONFIG.tools` (the GA-flat-shape tool schemas). This is the single source of truth for what the agent is told and what it can call. **Do not write your own instructions or tool schemas — import or port these exactly**, or your app's agent will silently drift from the one that's already been tested.
- **The tools**: `data-pipeline/src/tools.ts` — `search_fixtures`, `get_fixture_details`, `get_odds`, `get_my_activity`, `navigate`, `propose_bet`, `propose_deposit`. Pure functions; `runTool(name, argsJson) -> resultJson` is the dispatcher. Structurally incapable of placing a bet or completing a deposit — verified by an exhaustive allowlist test, not just by convention.
- **The protocol layer**: `data-pipeline/src/realtimeClient.ts` — the `RealtimeClient` interface, `buildSessionUpdate()`, and `GA_EVENTS` constants (the Preview→GA rename table already applied). `data-pipeline/src/conversationTurn.ts` — `runTurn()`, the turn-continuation state machine. **This one is worth reusing even in Swift, at least as a reference**: it encodes two real bugs (a response-already-active race, a response-done-before-tool-result-available race) that cost real debugging time to find. Re-deriving them from the Realtime API docs alone is exactly how they get reintroduced.
- **The token broker**: `data-pipeline/src/tokenBroker.ts` — run with `npm run broker` (from `data-pipeline/`), exposes `POST /connect` (send it your WebRTC offer SDP, get back the answer SDP) and `GET /health`. Mints the ephemeral key and embeds `AGENT_CONFIG` server-side — **your device never needs the real Azure API key, ever.** For local testing, expose it with `ngrok http 8787` and point your device at the ngrok URL.
- **The audit trail**: `data-pipeline/src/auditLog.ts` — every `navigate`/`propose_bet`/`propose_deposit` call gets logged to `data-pipeline/logs/audit.log` (JSONL) wherever `runTool` is actually invoked from.

## The one thing you need to decide: where does `runTool` actually run?

`tools.ts` has exactly one Node-specific dependency: `readFileSync` from `node:fs`, used only to load the four JSON files at module load. Every handler, `TOOL_SCHEMAS`, and `runTool` itself are otherwise plain, portable TypeScript — no other Node API, no network call, no RN incompatibility.

That means you have two legitimate options, and nothing in this codebase picks one for you:

**Option A — tools run on-device (recommended).** Bundle `dist/*.json` as JSON assets in the RN app (`import fixtures from './fixtures.json'` — RN's bundler handles this natively), copy `tools.ts` in with `readJson()`'s body swapped for those imports instead of `readFileSync`, and call `runTool` directly from your `RealtimeClient`'s `response.function_call_arguments.done` handler — the same way `conversationTurn.ts::runTurn` already does. Lower latency (no extra network hop), works offline, matches how `chatCli.ts` already works.

**Option B — tools run server-side.** Extend `tokenBroker.ts` with a `POST /tool-call` endpoint that calls `runTool` and returns the result; your device calls that instead of running `runTool` itself. Simpler porting (nothing to translate to RN), but adds a network round-trip per tool call and makes the broker a harder dependency (it must be up for the agent to do anything, not just to connect).

**Recommendation: Option A.** The whole point of Phase 0's data layer being static, committed JSON was to avoid a live dependency for exactly this kind of thing — Option B reintroduces one. If your RN project structure makes importing JSON awkward for some reason, Option B is a reasonable fallback, not a wrong choice — just tell me which one you're going with so the docs stay accurate.

## What you're building

```ts
// realtimeClient.ts's contract — your WebRTC client implements this,
// exactly the same shape RealtimeTextClient already does.
interface RealtimeClient {
  connect(): Promise<void>;
  disconnect(): void;
  sendEvent(event: ClientEvent): void;
  onEvent(handler: (event: ServerEvent) => void): () => void;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
}
```

1. **The native spike** — `react-native-webrtc` 124.0.8 on RN 0.87, confirm `RTCPeerConnection` reaches `connected` and `getUserMedia` grants mic access on your physical iPhone. No Azure involved yet.
2. **`WebRtcRealtimeClient`** — implements the interface above. POST your offer SDP to the token broker's `/connect` (not directly to Azure — the broker holds the key), get the answer SDP back, set it as your remote description. Pump GA events over the data channel through the same event names in `GA_EVENTS`.
3. **Mic capture + remote audio playback**, `AVAudioSession`/InCallManager speaker routing (`setForceSpeakerphoneOn(true)`, `useManualAudio = YES` on `RTCAudioSession` to avoid the AVAudioSession-contention failure mode).
4. **The Confirmation Gate's UI half** — this is real work that doesn't exist yet anywhere in this codebase:
   - When `propose_bet`/`propose_deposit` returns `{status: "awaiting_user_confirmation", ...}`, render a sheet showing the proposal (the result JSON has everything: fixture, market, selection, odds, stake, `potentialReturn`) with Confirm/Cancel.
   - **Mute the mic while that sheet is open.** No event exists that lets voice confirm a proposal — that's enforced by there being no `confirm_*` tool at all — but muting is still the right UX so a stray utterance can't be misread as an attempt to.
   - A tap on Confirm is what actually calls PSK's real, authenticated betslip API (out of scope here — that's the RN app's own account/session logic, not something this project touches). A tap on Cancel just discards the proposal.
   - `propose_bet`'s result also carries a `navigate` field (e.g. `{screen: "betslip", params: {fixtureId, marketId, outcomeId}}`) — use it to pre-fill whatever screen the sheet lives on.
5. **On-device end-to-end verification**: real spoken question → real spoken Azure answer, and one real tool call observed round-tripping.

## Two things you'll need to decide (not guessed at here)

- **`navigate`'s screen list** (`tools.ts`'s `KNOWN_SCREENS`) currently covers 11 of the ~43 real `fortuna_screen_name` values Phase 0 found in the analytics data — just the ones the demo script needs. If your app's screens don't match these names, either the list needs extending or your navigation layer needs a small name-mapping shim. Your call once your screens exist.
- **Deep-link scheme.** The original master plan wanted `navigate` to map to PSK's real `ftnhr://prematch/{sportId}/{categoryId}/{tournamentId}` scheme. What's built instead is a generic `{screen, params}` intent — deliberately not committed to a specific scheme, since that depends on whether your app uses PSK's real deep links, plain React Navigation route names, or something else. Tell me which and the tool can be adjusted to match in a few lines.

## Verification checklist for your side

- [ ] `RTCPeerConnection` reaches `connected`, `getUserMedia` returns a live track — physical device, not simulator.
- [ ] SDP exchange succeeds through the token broker (not directly against Azure).
- [ ] A spoken question gets a spoken answer.
- [ ] A tool call round-trips: `response.function_call_arguments.done` → `runTool` (on-device or via broker, per your choice above) → `conversation.item.create` with `function_call_output` → Azure continues the conversation.
- [ ] `propose_bet` never auto-confirms — the sheet appears, the mic is muted while it's open, and only a real tap calls PSK's betslip API.
- [ ] Check `data-pipeline/logs/audit.log` after a test session — every proposal you triggered should be in there.

## Environment

You need the token broker's URL (local + ngrok for now — ask for the current one, it changes) and nothing else. You specifically do **not** need `AZURE_OPENAI_API_KEY` — if you find yourself wanting it, something's wrong with how the device is connecting; it should only ever talk to the broker.
