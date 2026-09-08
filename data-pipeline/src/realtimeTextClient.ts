/**
 * RealtimeTextClient — WebSocket, text-only, direct API-key auth.
 *
 * Verified live against the real gpt-realtime-2.1-feg deployment: session
 * negotiation, streamed text, and real function-calling all confirmed
 * working. One correction found in the process and pinned here: the GA
 * WebSocket endpoint (unlike the WebRTC /calls endpoint) DOES require
 * `?model=<deployment>` in the query string — Azure returns
 * "OperationNotSupported" without it.
 *
 * Deliberately NOT how a mobile device should ever connect — this holds
 * the real API key directly, which is fine because it runs server-side (a
 * Windows dev machine here), the same way buildFixtures.ts does. A device
 * goes through the token broker (tokenBroker.ts) instead.
 */

import { WebSocket } from "ws";
import type { ClientEvent, ConnectionState, RealtimeClient, ServerEvent } from "./realtimeClient.ts";

export interface RealtimeTextClientOptions {
  /** Bare origin, e.g. https://your-resource.openai.azure.com — no path, no query. */
  endpoint: string;
  apiKey: string;
  deployment: string;
}

export class RealtimeTextClient implements RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly eventHandlers = new Set<(e: ServerEvent) => void>();
  private readonly stateHandlers = new Set<(s: ConnectionState) => void>();

  constructor(private readonly options: RealtimeTextClientOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState("connecting");
      const host = new URL(this.options.endpoint).host;
      const url = `wss://${host}/openai/v1/realtime?model=${encodeURIComponent(this.options.deployment)}`;
      const ws = new WebSocket(url, { headers: { "api-key": this.options.apiKey } });
      this.ws = ws;

      ws.on("open", () => {
        this.setState("connected");
        resolve();
      });
      ws.on("message", (raw) => {
        let evt: ServerEvent;
        try {
          evt = JSON.parse(raw.toString());
        } catch {
          return; // ignore anything that isn't valid JSON rather than crashing the session
        }
        for (const h of this.eventHandlers) h(evt);
      });
      ws.on("close", () => this.setState("disconnected"));
      ws.on("error", (err) => {
        this.setState("error");
        reject(err);
      });
      ws.on("unexpected-response", (_req, res) => {
        this.setState("error");
        reject(new Error(`Realtime WebSocket handshake failed: HTTP ${res.statusCode}`));
      });
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  sendEvent(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("sendEvent called while not connected");
    }
    this.ws.send(JSON.stringify(event));
  }

  onEvent(handler: (event: ServerEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private setState(state: ConnectionState): void {
    for (const h of this.stateHandlers) h(state);
  }
}
