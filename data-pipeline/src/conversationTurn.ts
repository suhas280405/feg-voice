/**
 * Shared "run one user turn to completion" state machine — extracted from
 * chatCli.ts so the precision/adherence test harness (testAgentBehavior.ts)
 * never has to duplicate response-continuation logic that took three rounds
 * of live debugging to get right (see docs/phase-1-voice-transport.md: the
 * response-already-active race and the deferred-continuation fix).
 *
 * A "turn" can span several response.create/response.done cycles chained
 * together — one per tool call the model makes along the way. This
 * function handles that chaining and executes tools via tools.ts's
 * runTool; the caller only sees text deltas and completed tool calls via
 * optional callbacks, and gets the full turn's result once it is truly done.
 */

import { recordAuditEntry } from "./auditLog.ts";
import { GA_EVENTS, type RealtimeClient, type ServerEvent } from "./realtimeClient.ts";
import { runTool } from "./tools.ts";

export interface ToolCallRecord {
  name: string;
  argsJson: string;
  resultJson: string;
}

export interface TurnCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolCall?: (record: ToolCallRecord) => void;
  onServerError?: (evt: ServerEvent) => void;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCallRecord[];
}

/**
 * Sends one user message and resolves once the model's full reply
 * (including any chained tool calls) is complete. Assumes the client is
 * already connected, session.update has already been acknowledged, and no
 * other turn is currently in flight on this client.
 */
export function runTurn(client: RealtimeClient, userText: string, callbacks: TurnCallbacks = {}): Promise<TurnResult> {
  return new Promise((resolve) => {
    let text = "";
    const toolCalls: ToolCallRecord[] = [];
    let needsContinuation = false;

    const unsubscribe = client.onEvent((evt: ServerEvent) => {
      switch (evt.type) {
        case GA_EVENTS.OUTPUT_TEXT_DELTA: {
          const delta = String((evt as { delta?: unknown }).delta ?? "");
          text += delta;
          callbacks.onTextDelta?.(delta);
          break;
        }
        case GA_EVENTS.FUNCTION_CALL_ARGUMENTS_DONE: {
          const { call_id, name, arguments: argsJson } = evt as unknown as {
            call_id: string;
            name: string;
            arguments: string;
          };
          const resultJson = runTool(name, argsJson);
          const record: ToolCallRecord = { name, argsJson, resultJson };
          toolCalls.push(record);
          // tools.ts / runTool stays side-effect-free by design (documented
          // and tested in Phase 3 as "no filesystem writes") — this is the
          // one real choke point every transport shares, so the audit
          // trail's write happens here instead, not inside runTool.
          recordAuditEntry(name, argsJson, resultJson);
          callbacks.onToolCall?.(record);
          client.sendEvent({
            type: GA_EVENTS.CONVERSATION_ITEM_CREATE,
            item: { type: "function_call_output", call_id, output: resultJson },
          });
          // This response is NOT "done" yet as far as Azure is concerned —
          // defer the continuation to RESPONSE_DONE below, or Azure rejects
          // it with "conversation_already_has_active_response".
          needsContinuation = true;
          break;
        }
        case GA_EVENTS.RESPONSE_DONE:
          if (needsContinuation) {
            needsContinuation = false;
            client.sendEvent({ type: GA_EVENTS.RESPONSE_CREATE });
          } else {
            unsubscribe();
            resolve({ text, toolCalls });
          }
          break;
        case GA_EVENTS.ERROR:
          callbacks.onServerError?.(evt);
          unsubscribe();
          resolve({ text, toolCalls });
          break;
      }
    });

    client.sendEvent({
      type: GA_EVENTS.CONVERSATION_ITEM_CREATE,
      item: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    });
    client.sendEvent({ type: GA_EVENTS.RESPONSE_CREATE });
  });
}

/**
 * One retry on connection failure. A transient DNS/network blip (observed
 * directly against this exact Azure host during testing) would otherwise
 * crash the whole process via an unhandled rejection on a bare
 * `await client.connect()` — chatCli.ts and testAgentBehavior.ts both hit
 * this before it was fixed here, once.
 */
export async function connectWithRetry(client: RealtimeClient, onRetry?: (err: unknown) => void): Promise<void> {
  try {
    await client.connect();
  } catch (err) {
    onRetry?.(err);
    await client.connect(); // a second consecutive failure is a real problem — let it propagate
  }
}

/** Resolves once session.update has been acknowledged — connect() alone isn't enough to safely send the first turn. */
export function waitForSessionReady(client: RealtimeClient): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = client.onEvent((evt) => {
      if (evt.type === GA_EVENTS.SESSION_UPDATED) {
        unsubscribe();
        resolve();
      }
    });
  });
}
