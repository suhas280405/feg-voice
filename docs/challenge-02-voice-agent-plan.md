# FEG Hackathon — Challenge 02: Voice Search Agent for the PSK iOS App

## Context

**The challenge.** FEG Challenge 02 is *"Native App Experience — Relevance on Every Surface"*:
> "How might we bring a user's selected interests, teams and activity to every surface of their device"

Its stated problem is that PSK is invisible between sessions, live moments are lost to third-party apps, broadcast pushes are ignored, and "the OS canvas sits unused." Listed innovation areas: widgets, Live Activities, Dynamic Island, watch complications, geolocation, shortcuts, **voice search**. Deliverable: *"a standalone native demo app on real devices with sample data."* Guardrail: *"OS surfaces are the most personal space we could occupy — misuse destroys trust permanently."*

Judging weights: **business impact 30%, CX 20%, originality 15%, technical feasibility 15%, product thinking 10%, compliance 10%.**

**Our angle.** A voice agent that is a *navigator and researcher, never a decision-maker*. Three behaviours define it:

1. **Informational asks execute immediately.** "What's the score in India vs Australia?" → the agent answers by voice and drives the app to the match screen.
2. **Consequential asks never execute.** "Put €20 on Australia" → the agent routes to the bet slip with the selection and stake pre-filled, then stops at a confirmation sheet. **The user's tap is the only thing that places a bet.** Voice cannot confirm.
3. **Ambiguity is always returned to the user.** If the match, market, selection or stake is unclear or matches more than one fixture, the agent asks — it never guesses a fixture, a market or an amount.

**Why this scores.** Voice is the lowest-friction surface for the "live moment" the challenge says PSK is losing, and a hard confirmation gate turns the biggest risk of a gambling voice agent (an AI placing bets) into the demo's headline safety story — directly serving the 10% compliance weight and the guardrail above.

## What we already know about the target app

The provided `top_sport_users_event_logs.csv` is a real analytics export from the PSK iOS app, and it hands us two things we should exploit rather than invent:

- **43 real instrumented screen names** in `fortuna_screen_name` — `homepage`, `searchPrematch`, `searchLive`, `prematchDetail`, `liveDetail`, `liveEvents`, `prematchLeagues`, `prematchMatchesOverview`, `competition_detail`, `betslip`, `ticket`, `ticketDetail`, `ticketHistory`, `promotions`, `my_account`, `webviewresponsibleGame`, and more.
- **Real analytics event names**: `fortuna_screen_view`, `betslip_add_bet`, `betslip_placed`, `betslip_placed_bet`, `casino_game_launch`.

`EPS_Offers.csv` is a real odds feed (`sport_name, tournament_name, match_name, market_name, current_odds, start_datetime_utc, end_datetime_utc, is_current_flag`) covering Soccer, Basketball, Tennis, Ice Hockey and MMA across 200+ tournaments.

**Implication for the design:** the agent's `navigate` tool takes the operator's *own* screen names as its target enum, and every agent-driven action emits the operator's *own* analytics events. That makes the voice agent measurable inside PSK's existing funnel on day one — which is the 30%-weighted business-impact argument, not a slide.

### PSK's live public API (verified, unauthenticated)

psk.hr is an Astro shell around Vue micro-frontends — the HTML is skeletons, so scraping is useless, but the JSON offer API behind it answers plain unauthenticated GETs. Base `https://api.psk.hr`, offer prefix `/offer`:

| Endpoint | Use |
|---|---|
| `/offer/structure/api/v1_0/sports` | 39 sports with live counts (Nogomet, Tenis, Košarka, Kriket, e-sports…) |
| `/offer/structure/api/v1_0/widget/live/fixtures` | ~112 KB — sports + tournaments + fixtures + markets in one call |
| `/offer/structure/api/v1_0/fixture/{id}?markets=true` | Full fixture: participants, crests, kickoff, breadcrumb, feature flags |
| `/offer/markets/api/v1_0/fixture/{id}/markets` | 33 market types on one football match, with `previousOdds` for drift |
| `/offer/stats-v2/api/v2_0/fixture/{id}/scoreboard` | Live score, period breakdown, `gameTime`, cards, corners |
| `/offer/seo/api/v1_0/{sport\|tournament\|fixture}/{seoName}/id` | **Slug → ID resolver — exactly what voice search needs** |
| `/offer/structure/api/v1_0/widget/top-leagues` | Returns `nativeUrl` deep links |

Hierarchy is **sport → category (country) → tournament → fixture**, with Fortuna "ufo" URNs (`ufo:sprt:00`, `ufo:ctgr:00-26`, `ufo:tour:00-06y`, `ufo:mtch:1vu-06f`).

**Real native deep-link scheme:** `ftnhr://prematch/{sportId}/{categoryId}/{tournamentId}` — our `navigate` tool should speak this, not an invented route format.

Everything financial (`/tas/...` betslip create/legs/set-stake/**submit**, and `/pams/api/v2/...` `gamingLimits`, `depositLimits`, `exclusionStatus`, `balances`) is session-authenticated. **We never touch these.** Our bet slip is entirely local — which is also why the agent is structurally incapable of placing a real bet.

**Precedent worth citing to judges:** PSK already ships an LLM assistant micro-frontend at `/fe/bet-gpt/` with `POST /api/chat` and a `/api/check-request-limit` rate-limit endpoint. Our submission is the *voice* and *native-surface* evolution of something they've already committed to — plus the safety layer it lacks.

### Croatian lexicon (from the live API)

Market names come back Croatian, so the agent needs a mapping table, not translation guesswork:

`Osnovna ponuda` = 1X2 · `Osnovna ponuda dvoznak` = double chance · `Zbroj golova` (`više`/`manje` 3.5) = over/under · `Oba daju gol` (`Da`/`Ne`) = BTTS · `Hendikep` · `Ishod bez neriješenog` = draw no bet · `Poluvrijeme / kraj` = HT/FT · `Točan rezultat` = correct score · `Tko postiže 1. gol` = first goalscorer · `tiket` = bet slip · `ulog` = stake · `kvota` = odds.

## Decisions taken

| Decision | Choice |
|---|---|
| Model | `gpt-realtime-2.1-feg`, an **Azure OpenAI** realtime deployment |
| App | **Bare React Native**, iOS; the Xcode project is ours and a teammate owns the native side |
| Widgets / Live Activity / Dynamic Island | **Teammate implements in Swift**; this workstream defines the data contract and the RN-side API |
| Match & odds data | **Committed JSON snapshot of PSK's real public API**, with a debug toggle for live fetch |
| Language | **Agent speaks English; understands and maps Croatian** market/team names from the real data |
| Sensitive-action UX | **Navigate + pre-filled sheet + explicit tap to confirm.** Voice can never confirm. |

## Architecture

```
┌─ RN / TypeScript ───────────────────────────────────────────┐
│  UI screens (mirroring real fortuna_screen_name taxonomy)   │
│  VoiceAgentOverlay ── transcript, state, barge-in, mute     │
│                                                             │
│  agent/                                                     │
│   ├─ RealtimeClient      transport-agnostic session driver  │
│   ├─ tools/              tool schemas + handlers            │
│   ├─ ConfirmationGate    classifies + blocks sensitive calls│
│   └─ ResponsibleGaming   pre-tool policy checks             │
│                                                             │
│  data/  fixtures.json, markets.json, userProfile.json       │
│  nav/   screen registry keyed by fortuna_screen_name        │
│  analytics/ emits betslip_add_bet, fortuna_screen_view, …   │
└──────────────┬──────────────────────────────────────────────┘
               │ offer SDP  ▸  answer SDP   (device holds no key)
┌──────────────▼─────────┐        ┌─────────────────────────┐
│ token broker / SDP     │───────▶│ Azure OpenAI Realtime   │
│ proxy, holds Azure key │        │ gpt-realtime-2.1-feg    │
└────────────────────────┘        └─────────────────────────┘
               ▲ WebRTC audio + JSON events on the data channel
┌──────────────┴──────────────────────────────────────────────┐
│ Native iOS (teammate): react-native-webrtc, AVAudioSession, │
│ App Group ▸ WidgetKit widget + ActivityKit Live Activity    │
└─────────────────────────────────────────────────────────────┘
```

### Transport — WebRTC, and use the GA protocol

**Critical:** the Azure Realtime *Preview* protocol was **deprecated on 2026-04-30**. Almost every tutorial and LLM-remembered snippet still shows it. Do not use:

- ❌ `https://<region>.realtimeapi-preview.ai.azure.com/v1/realtimertc`
- ❌ `POST /openai/realtimeapi/sessions?api-version=2025-04-01-preview`
- ❌ `wss://<res>.openai.azure.com/openai/realtime?api-version=…&deployment=…`

**GA endpoints — on our own resource host, with no `api-version` anywhere:**

| Purpose | URL |
|---|---|
| Mint ephemeral key | `POST https://<resource>.openai.azure.com/openai/v1/realtime/client_secrets` |
| WebRTC SDP exchange | `POST https://<resource>.openai.azure.com/openai/v1/realtime/calls` |

Adding `api-version` causes a **401**. There is no `?deployment=` or `?model=` param — the deployment name `gpt-realtime-2.1-feg` goes in the body as `session.model`. Do **not** send the `OpenAI-Beta` header.

Azure-only bonus: `POST /openai/v1/realtime/calls?webrtcfilter=on` restricts which events reach the device, keeping our `instructions` prompt server-side. For a gambling app whose safety rules live in that prompt, **turn this on.**

We use **WebRTC via `react-native-webrtc` 124.0.8**, not WebSocket. WebRTC gives Opus, hardware echo cancellation, jitter buffering and packet-loss concealment for free, and is the only transport where ephemeral-key auth is documented — a WebSocket client on-device would mean embedding a real Azure key. Microsoft measures WebRTC at ~100 ms vs WebSocket at ~200 ms and says outright that WebSockets aren't recommended for realtime audio. Building the WebSocket path would mean a bespoke Swift PCM16/24 kHz capture-and-playback module with hand-rolled AEC and a jitter buffer: realistically 3–7 days, and the wrong risk before a live demo.

### The token broker — proxy the SDP, don't just mint

The Azure key **must not ship in the bundle**: an extracted key is an unmetered LLM bill and, for a regulated operator, an audit finding. Azure documents a shape that's better than plain token-minting and is what we should build:

The device POSTs its **offer SDP** to our `/connect`. The broker mints the ephemeral key server-side, forwards the offer to `/openai/v1/realtime/calls`, and returns the **answer SDP**. The device never holds a token at all. Azure returns a `Location: /v1/realtime/calls/rtc_…` header, which lets the broker open a server-side **observer WebSocket** on the same call — the natural place to log every tool call for the compliance audit trail.

Ephemeral keys default to a 600 s TTL (`expires_after.seconds`, 10–7200); max session length is 60 minutes. Mint immediately before connecting — an expired key shows up as "the data channel never opens."

### RN wiring notes that will otherwise cost us a day

- `registerGlobals()` once at app start, or the polyfills aren't installed.
- The SDP POST body is a **raw string** with `Content-Type: application/sdp`. Do not `JSON.stringify` it.
- There is no `<audio>` element in RN — remote audio routes through the iOS audio session automatically. The usual "no inbound audio" bug is the peer connection being garbage-collected: hold it in a module-level ref, not component state.
- **Data channel label:** OpenAI docs say `oai-events`, Azure's GA sample says `realtime-channel`. If events never arrive, swap the label first — it's a ten-second test.
- **AVAudioSession contention** is the classic failure. `RTCAudioSession` is a singleton that assumes it owns the session, and InCallManager mutates it too; they race, producing silence after reconnect, output stuck on the earpiece, or echo loops. Set `useManualAudio = YES` on `RTCAudioSession` in `AppDelegate` and drive activation ourselves. **This is a teammate task, and it should happen in week one.**
- InCallManager defaults audio to the **earpiece** — a voice assistant needs `setForceSpeakerphoneOn(true)`, which in turn makes hardware AEC essential (`playAndRecord` + voice-chat mode), or the model hears itself and self-interrupts forever.
- `Info.plist`: `NSMicrophoneUsageDescription` and `UIBackgroundModes: [audio]`. Omit camera permission entirely to avoid App Review questions.
- If the venue network is locked down, Azure needs UDP/TCP **3478** open to the `AzureCloud.<region>` service tag.

## Tool design — the core of the submission

Tools are split into tiers, and the tier is enforced **in our code**, not by prompting. A prompt-only guard is one jailbreak away from placing a real bet.

**Tier 1 — Read (executes immediately)**
- `search_fixtures(query, sport?, tournament?, when?)` → candidate matches. Returns *all* plausible matches; never auto-picks.
- `get_fixture_details(fixture_id)` → teams, competition, kickoff, live score, key markets.
- `get_odds(fixture_id, market?)` → prices for a market.
- `get_my_activity()` → open tickets, followed teams, from `userProfile.json`.

**Tier 2 — Navigate (executes immediately, no financial effect)**
- `navigate(screen, params)` where `screen` is constrained to the real taxonomy (`prematchDetail`, `liveDetail`, `searchPrematch`, `betslip`, `ticketHistory`, `promotions`, `webviewresponsibleGame`, …). Params carry real `ufo:` URNs, and the registry maps to PSK's real deep-link form `ftnhr://prematch/{sportId}/{categoryId}/{tournamentId}` so the same tool would drive the production app unchanged. Emits `fortuna_screen_view`.
- `resolve_entity(slug_or_name)` → wraps the same idea as PSK's own `/offer/seo/api/v1_0/.../{seoName}/id` resolver: turns "Liga prvaka" or "Champions League" into a tournament ID.

**Tier 3 — Propose (CANNOT execute)**
- `propose_bet(fixture_id, market, selection, stake, currency)`
- `propose_deposit(amount, currency)`

These handlers **always** return `{"status":"awaiting_user_confirmation"}`. They mutate no balance and place no bet. Their only side effect is navigating to the pre-filled screen and raising the confirmation sheet. The model is told in its instructions that it has no capability to complete these — it can only prepare them.

**Tier 4 — Ask**
- `ask_clarification(question, options[])` → renders selectable chips *and* is spoken. Used whenever `search_fixtures` returns more than one candidate, a market is ambiguous, or a stake is missing.

### The Confirmation Gate

A single module every tool call passes through. It:
1. Rejects any Tier-3 call with a missing or non-numeric stake, an unknown `fixture_id`, or a selection not present in that fixture's markets — returning a structured error that forces the model to ask rather than retry.
2. Requires **explicit slot completeness**: fixture + market + selection + stake + currency. No defaulting a stake, ever.
3. Renders the sheet showing fixture, market, selection, odds, stake and **potential return**, with Confirm and Cancel. Confirm is a tap only — the mic is muted while the sheet is open, so no utterance can be misread as consent.
4. Logs every proposal and its outcome to an on-screen **audit trail**, which doubles as the compliance demo.

**Research confirms this must be client-side.** The Realtime API has **no protocol-level approval mechanism for function tools** — `require_approval` exists only for server-side `type: "mcp"` tools, not ours. So the gate cannot be delegated to the model or the API; it has to be our code. Concretely: on `response.function_call_arguments.done` for a Tier-3 tool we **do not execute**. We render the sheet, and only after the user taps Confirm do we send `conversation.item.create` with a `function_call_output`. On Cancel we send `{"status":"declined_by_user"}` so the model narrates the refusal gracefully instead of retrying.

### Responsible-gaming policy layer

Runs before Tier 3 and is non-negotiable in code:
- Stake above the user's configured session limit → refuse, offer `webviewresponsibleGame`.
- "Bet everything / chase my losses / double until I win" → refuse, no counter-offer, surface support.
- Agent never volunteers a bet, never upsells, never suggests a stake amount. It answers what was asked.
- Self-excluded or cooling-off profile → all Tier-3 tools are unregistered for the session entirely, so the model cannot see them.

This is a direct answer to the challenge's own guardrail and to the "no dark patterns" requirement.

### Keeping the agent from deciding on its own

- Instructions state the agent is a *navigator and researcher*, that guessing is a failure, and that one unresolved slot means one spoken question.
- `search_fixtures` returning ≥2 candidates makes `ask_clarification` the only valid next call.
- **`semantic_vad` with `eagerness: "low"`** rather than `server_vad`, so the agent waits out a hesitating user instead of committing on a half-sentence. *Verify it actually applies by inspecting the `session.updated` echo — there is an open report of Azure silently ignoring `semantic_vad`.* Fall back to `server_vad` with a generous `silence_duration_ms` if so.
- **Moderation gate: `create_response: false`.** VAD still segments turns, but the model does not speak until *we* send `response.create`. That gives us a hook to read the finished transcript (`conversation.item.input_audio_transcription.completed`) and decide whether to proceed or re-prompt — the cleanest way to stop the model acting on garbled input.
- **Barge-in on WebRTC** is one event: `input_audio_buffer.clear` → `response.cancel` → **`output_audio_buffer.clear`** (WebRTC-only; drops unplayed audio *and* truncates the conversation item so the model's context matches what the user actually heard).
- Every spoken claim about a match is traceable to a fixture record — no free-form invented scores.

### GA schema gotchas to encode once, in one adapter file

The GA rename set breaks preview-era code silently, and **Azure's own overview page still shows stale preview JSON** — trust the WebRTC/WebSockets how-tos and the migration guide instead.

| Preview | GA |
|---|---|
| `response.text.delta` | `response.output_text.delta` |
| `response.audio.delta` | `response.output_audio.delta` |
| `response.audio_transcript.delta` | `response.output_audio_transcript.delta` |
| content part `"text"` / `"audio"` | `"output_text"` / `"output_audio"` |
| `modalities` | `output_modalities` |

Also: `session.update` now **requires `session.type: "realtime"`**; audio config is nested under `session.audio.input` / `.output` (flat `input_audio_format` and root-level `voice`/`turn_detection` are preview-era); and tools use the **flat** Responses shape — `name`/`description`/`parameters` at the top level of the tool object, *not* nested under a `function` key.

```jsonc
{ "type": "session.update",
  "session": {
    "type": "realtime",
    "model": "gpt-realtime-2.1-feg",          // the deployment name
    "instructions": "…navigator, not decision-maker…",
    "output_modalities": ["audio"],
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": { "model": "<transcribe-deployment>" },
        "turn_detection": { "type": "semantic_vad", "eagerness": "low",
                            "create_response": false, "interrupt_response": true }
      },
      "output": { "format": { "type": "audio/pcm", "rate": 24000 }, "voice": "marin" }
    },
    "tools": [ /* flat shape */ ],
    "tool_choice": "auto"
  } }
```

Parse tool calls from `response.function_call_arguments.done` (`call_id`, `name`, `arguments` as a JSON **string**), not from the deltas.

## Demo script (this drives the build order)

1. **"What's on in the Champions League tonight?"** → resolves the Croatian slug, speaks the fixtures, navigates to `prematchMatchesOverview`. *Real PSK data.*
2. **"Tell me about India versus Australia."** → `prematchDetail` (PSK carries **Kriket**), speaks competition, start time, live score, headline odds — translating `Osnovna ponuda` into plain English.
3. **"Put twenty euro on Australia."** → routes to `betslip`, pre-filled, **stops at the confirmation sheet**. Presenter pauses here: *"The agent has prepared this. It cannot place it. Only this tap can."* Tap → `betslip_add_bet` and `betslip_placed` fire, the same events PSK already records.
4. **"Put fifty on the next one."** → *"Which match do you mean — I can see three starting within the hour."* The agent refusing to guess is the point of the step.
5. **"Just bet my whole balance, win it back for me."** → refuses, offers no alternative stake, surfaces `webviewresponsibleGame` and igrajmoodgovorno.hr.
6. **Live Activity** appears on the Lock Screen and Dynamic Island for the open bet, and the widget shows the followed match — closing the loop back to the challenge's own "relevance on every surface" framing.

Build in exactly this order. Each step is independently demoable, so we always have something to show.

## Build phases

**Phase 0 — Foundations**
- Confirm the bare RN project state with the teammate; agree the `ios/` ownership boundary.
- Write a small snapshot script that pulls `sports`, `widget/live/fixtures`, per-fixture `markets` and `scoreboard` from `api.psk.hr` for a chosen set of tournaments, and commits the result as `fixtures.json` / `markets.json`. Honour `Crawl-delay: 20`. Freeze a demo clock so kickoff times stay sensible on stage.
- Build the Croatian → intent lexicon table from the snapshot's actual `marketTypeName` values.
- Distil `userProfile.json` (favourite teams, open tickets, limits) from the provided player/event CSVs — these need a **proper CSV parser**, since `EPS_Offers.csv` has embedded commas inside quoted fields and naive splitting shifts columns.

**Phase 1 — Voice transport** *(start with the spike; it gates everything)*
- **Day-one spike:** `react-native-webrtc` 124.0.8 building and passing audio on our exact RN version, on a physical iPhone. Nothing else matters until this is green.
- Token broker with the SDP-proxy `/connect` shape; `RealtimeClient` connects, streams mic, plays remote audio, opens the data channel.
- Ship a **mock transport** behind the same interface so screens and tools are testable without credentials, and so a venue Wi-Fi failure does not end the demo.

**Phase 2 — Screens + navigation registry**
- Screens keyed by real `fortuna_screen_name` values: homepage, search, prematch overview, prematch/live detail, bet slip, ticket history, responsible gaming.
- Analytics emitter using the real event names.

**Phase 3 — Tools, gate and policy**
- Tier 1/2 tools, then the Confirmation Gate, then Tier 3 proposals, then the responsible-gaming layer, then `ask_clarification`.
- Unit-test the gate hard: every Tier-3 path must be provably unable to place a bet.

**Phase 4 — OS surfaces (teammate, in Swift)**
- App Group shared container + an `ActivityAttributes` JSON contract this workstream defines and writes to.
- Live Activity for a live match with an open bet; Dynamic Island compact/expanded; home-screen widget for followed matches.

**Phase 5 — Demo hardening**
- Offline fallback, scripted-utterance fallback, on-device rehearsal, audit-trail screen.

## Risks

| Risk | Mitigation |
|---|---|
| **`react-native-webrtc` under RN 0.82+ bridgeless.** The New Architecture tracking issue closed the day 124.0.8 shipped, but the package ships no `codegenConfig` and there's no published compatibility table. **Biggest unknown in the plan.** | **Spike this on day one**, before anything else. If it fails on our RN version, fall back to an older RN or a thin native Swift WebRTC module behind the same `RealtimeClient` interface |
| Preview-vs-GA protocol confusion (stale docs, stale training data) | Endpoints and event names pinned above; all of it isolated in one adapter file so a correction is a single edit |
| `gpt-realtime-2.1` is **not in Microsoft's published model list** (latest documented: `gpt-realtime-2`, 2026-05-07) | Confirm the underlying base model version in the Foundry portal early; the deployment name itself is arbitrary and works either way |
| `semantic_vad` reportedly ignored by Azure | Assert on the `session.updated` echo; fall back to tuned `server_vad` |
| Venue audio / Wi-Fi failure on stage | Mock transport + scripted fallback + rehearsed on-device run |
| AVAudioSession contention (silence, earpiece-only, echo loop) | `useManualAudio = YES` and drive activation ourselves; test on a real device in week one |
| Model tries to place a bet directly | Impossible by construction — no tool exists that can. Gate is code, not prompt |
| Croatian market names mis-mapped, agent quotes the wrong market | Lexicon is a committed table built from real `marketTypeName` values, not model translation; unmapped market ⇒ `ask_clarification` |
| PSK API shape changes or rate-limits us | Snapshot is committed; live fetch is a debug toggle only, never the demo path |

## Verification

- **Gate tests**: unit tests asserting every Tier-3 handler returns `awaiting_user_confirmation` and touches no balance; property-style test over malformed slot combinations asserting the sheet never opens.
- **Policy tests**: a fixture list of adversarial utterances ("just do it", "you decide", "bet it all", "confirm for me") asserting no confirmation ever occurs without a tap.
- **Ambiguity tests**: ambiguous queries must produce `ask_clarification`, never a `propose_bet`.
- **End-to-end**: run the six-step demo script on a physical iPhone, start to finish, twice, and record it as the submission video.
- **Analytics check**: confirm agent-driven flows emit `fortuna_screen_view`, `betslip_add_bet`, `betslip_placed` identically to manual flows, so impact is measurable in PSK's existing funnel.

## Reference links worth keeping open

- [Preview → GA migration guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-preview-api-migration-guide) — the authority on what changed
- [Realtime via WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc)
- [OpenAI Realtime API reference](https://developers.openai.com/api/reference/resources/realtime) — Azure's event reference now redirects here
- [react-native-webrtc iOS installation](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/iOSInstallation.md) · [audio session issue #1438](https://github.com/react-native-webrtc/react-native-webrtc/issues/1438)
- ⚠️ [Azure Realtime overview page](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio) — prose is GA but **its JSON samples are stale preview**. Don't copy from it.

## Open items

- Azure resource host name, region, and confirmation of the base model behind `gpt-realtime-2.1-feg` in the Foundry portal.
- Where the token broker is hosted for the demo, and whether Entra ID or an API key is used against Azure.
- Our exact React Native version, for the day-one WebRTC spike.
- The Google Drive folder is not readable from this session — if it holds brand assets, an API spec or additional data, those files need to be placed in `E:\feg-hackathon`.
- Confirm with the teammate whether the bare RN project already exists or is being scaffolded now.
