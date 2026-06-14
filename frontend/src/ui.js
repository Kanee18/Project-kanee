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
    this._characterName = document.querySelector("header h1")?.textContent || "Kanee";
  }

  /** Stream-chat row: colored name + message. Voice gets a mic mark. */
  addUserMessage(text, { voice = false } = {}) {
    const row = this._makeRow("user", "You");
    if (voice) {
      const mark = document.createElement("span");
      mark.className = "mic-mark";
      mark.title = "Voice message";
      // Inline mic icon (matches the footer talk button); static markup, no input.
      mark.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
        '<path d="M5 10a7 7 0 0 0 14 0"/>' +
        '<line x1="12" y1="19" x2="12" y2="22"/></svg>';
      row.appendChild(mark);
    }
    row.appendChild(document.createTextNode(text));
    this._scroll();
  }

  /** The next segment starts a fresh assistant row. */
  newReply() {
    this._assistantBubble = null;
  }

  /** Append one segment to the current assistant row (reply streams in). */
  addSegment({ text, emotion, gesture }) {
    if (this._assistantBubble === null) {
      this._assistantBubble = this._makeRow("kanee", this._characterName);
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

  _makeRow(kind, name) {
    const row = document.createElement("div");
    row.className = `msg ${kind}`;
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    row.appendChild(nameEl);
    this._log.appendChild(row);
    if (kind === "kanee") this._assistantBubble = row;
    return row;
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
