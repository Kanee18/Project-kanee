/**
 * Chat log, state indicator, connection badge, error toasts.
 * Pure DOM — no protocol or audio logic here.
 */
export class UI {
  constructor() {
    this._log = document.getElementById("log");
    this._state = document.getElementById("state");
    this._conn = document.getElementById("conn");
    this._toasts = document.getElementById("toasts");
    this._assistantBubble = null;
  }

  /** Add a user message bubble. Voice transcripts get a mic mark. */
  addUserMessage(text, { voice = false } = {}) {
    const div = document.createElement("div");
    div.className = "msg user";
    if (voice) {
      const mark = document.createElement("span");
      mark.className = "mic-mark";
      mark.textContent = "\u{1F3A4}";
      div.appendChild(mark);
    }
    div.appendChild(document.createTextNode(text));
    this._log.appendChild(div);
    this._scroll();
  }

  /** The next segment starts a fresh assistant bubble. */
  newReply() {
    this._assistantBubble = null;
  }

  /** Append one segment to the current assistant bubble. */
  addSegment({ text, emotion, gesture }) {
    if (this._assistantBubble === null) {
      this._assistantBubble = document.createElement("div");
      this._assistantBubble.className = "msg kanee";
      this._log.appendChild(this._assistantBubble);
    }
    const seg = document.createElement("span");
    seg.className = "seg";
    const tags = document.createElement("span");
    tags.className = "seg-tags";
    tags.textContent = `[${emotion}]` + (gesture ? `[${gesture}]` : "");
    seg.appendChild(tags);
    seg.appendChild(document.createTextNode(text));
    this._assistantBubble.appendChild(seg);
    this._scroll();
  }

  setState(value) {
    this._state.textContent = value;
    this._state.className = value;
  }

  setConnected(ok) {
    this._conn.textContent = ok ? "connected" : "reconnecting…";
    this._conn.className = ok ? "ok" : "";
  }

  /** Error toast with a plain-language message; auto-dismisses. */
  toast(message) {
    const div = document.createElement("div");
    div.className = "toast";
    div.textContent = message;
    div.onclick = () => div.remove();
    this._toasts.appendChild(div);
    setTimeout(() => div.remove(), 8000);
  }

  _scroll() {
    this._log.scrollTop = this._log.scrollHeight;
  }
}
