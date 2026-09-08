/**
 * Transport-agnostic realtime client interface + shared GA protocol pieces
 * (Phase 1 — see docs/phase-1-voice-transport.md).
 *
 * One implementation exists today: RealtimeTextClient (realtimeTextClient.ts),
 * over plain WebSocket, text-only — verified directly against the real
 * gpt-realtime-2.1-feg deployment. A WebRTC implementation for the real RN
 * app is future work, blocked on the teammate's Mac/iPhone; this interface
 * is what it will also implement, so chatCli.ts today (and RN screens/tools
 * later) never need to know which transport is underneath.
 */

export type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export interface ClientEvent {
  type: string;
  [key: string]: unknown;
}
export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export interface RealtimeClient {
  connect(): Promise<void>;
  disconnect(): void;
  sendEvent(event: ClientEvent): void;
  /** Returns an unsubscribe function. */
  onEvent(handler: (event: ServerEvent) => void): () => void;
  /** Returns an unsubscribe function. */
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
}

// ---------------------------------------------------------------------------
// GA session.update builder — pinned exactly as verified live against Azure.
// One place, so a correction is one edit instead of a hunt.
// ---------------------------------------------------------------------------

export interface SessionUpdateOptions {
  model: string;
  instructions: string;
  outputModalities: ("audio" | "text")[];
  /** Pass TOOL_SCHEMAS from tools.ts through as-is — already the correct GA flat shape. */
  tools: readonly unknown[];
  /** Only meaningful when outputModalities includes "audio". */
  voice?: string;
}

export function buildSessionUpdate(opts: SessionUpdateOptions): ClientEvent {
  const audio = opts.outputModalities.includes("audio")
    ? {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "low",
            create_response: false,
            interrupt_response: true,
          },
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: opts.voice ?? "marin" },
      }
    : undefined;

  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: opts.model,
      instructions: opts.instructions,
      output_modalities: opts.outputModalities,
      ...(audio ? { audio } : {}),
      tools: opts.tools,
      tool_choice: "auto",
    },
  };
}

// ---------------------------------------------------------------------------
// GA event name constants — the Preview -> GA rename table, so nobody types
// a stale event name string from memory or an outdated tutorial.
// ---------------------------------------------------------------------------

export const GA_EVENTS = {
  SESSION_UPDATE: "session.update",
  SESSION_CREATED: "session.created",
  SESSION_UPDATED: "session.updated",
  CONVERSATION_ITEM_CREATE: "conversation.item.create",
  RESPONSE_CREATE: "response.create",
  RESPONSE_CANCEL: "response.cancel",
  OUTPUT_TEXT_DELTA: "response.output_text.delta",
  OUTPUT_TEXT_DONE: "response.output_text.done",
  OUTPUT_AUDIO_TRANSCRIPT_DELTA: "response.output_audio_transcript.delta",
  OUTPUT_AUDIO_TRANSCRIPT_DONE: "response.output_audio_transcript.done",
  FUNCTION_CALL_ARGUMENTS_DELTA: "response.function_call_arguments.delta",
  FUNCTION_CALL_ARGUMENTS_DONE: "response.function_call_arguments.done",
  RESPONSE_DONE: "response.done",
  ERROR: "error",
} as const;
