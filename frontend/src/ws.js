/**
 * WebSocket client + message protocol (see CLAUDE.md).
 *
 * Outbound: {type:"user_text", text} | {type:"user_audio", audio} | {type:"interrupt"}
 * Inbound:  state | transcript | segment | reply_done | error
 *
 * Reconnects automatically with backoff. `send` returns false when the
 * socket is down so the caller can surface it instead of silently dropping.
 */
import { BACKEND_URL } from "../../shared/firebase-config.js";

/**
 * Where to open the WebSocket. Priority:
 *   1. ?api=<url> query param (persisted) — point a deployed app at a changing
 *      tunnel URL without rebuilding.
 *   2. localStorage "kanee_backend" (set by #1 on a previous visit).
 *   3. BACKEND_URL from the shared config (a deployed/remote backend).
 *   4. same-origin /ws — local dev, where Vite proxies /ws to the backend.
 * A base URL (http/https) is converted to ws/wss and gets "/ws" appended.
 */
function resolveWsUrl() {
  try {
    const q = new URLSearchParams(location.search).get("api");
    if (q) localStorage.setItem("kanee_backend", q.trim());
  } catch {
    /* private mode / blocked storage — ignore */
  }
  let base = "";
  try {
    base = localStorage.getItem("kanee_backend") || "";
  } catch {
    /* ignore */
  }
  if (!base) base = BACKEND_URL || "";
  if (base) {
    return base.trim().replace(/^http/i, "ws").replace(/\/+$/, "") + "/ws";
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export class WSClient {
  constructor() {
    this._handlers = new Map();
    this._connListeners = [];
    this._ws = null;
    this._delay = 1000;
    this._connect();
  }

  /** Register a handler for one inbound message type. */
  on(type, fn) {
    this._handlers.set(type, fn);
    return this;
  }

  /** Notified with true/false on connect/disconnect. */
  onConnection(fn) {
    this._connListeners.push(fn);
    return this;
  }

  /** Send one protocol message. Returns false if not connected. */
  send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  _connect() {
    const ws = new WebSocket(resolveWsUrl());
    this._ws = ws;

    ws.onopen = () => {
      this._delay = 1000;
      this._connListeners.forEach((fn) => fn(true));
    };
    ws.onclose = () => {
      this._connListeners.forEach((fn) => fn(false));
      setTimeout(() => this._connect(), this._delay);
      this._delay = Math.min(this._delay * 1.7, 8000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        console.warn("ws: non-JSON message", ev.data);
        return;
      }
      const fn = this._handlers.get(msg.type);
      if (fn) fn(msg);
      else console.warn("ws: unhandled message type", msg);
    };
  }
}
