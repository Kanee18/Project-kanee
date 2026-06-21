/**
 * Visual-novel dialogue box, state chip, connection chip, error toasts.
 * Pure DOM — no protocol or audio logic here.
 *
 * The box shows the CURRENT speaker's line: the user's message while she
 * thinks, then her reply (segments accumulate into one line). It's not a
 * scrolling transcript — that's the VN look the user asked for.
 */
export class UI {
  constructor() {
    this._state = document.getElementById("state");
    this._conn = document.getElementById("conn");
    this._toasts = document.getElementById("toasts");
    this._name = document.getElementById("nameplate");
    this._text = document.getElementById("dialogue-text");
    this._characterName = this._name?.dataset.name || "Kanee";
    this._speaker = null;     // "user" | "kanee"
    this._freshReply = false; // next segment starts a new Kanee line

    // Conversation backlog (the VN "history" panel).
    this._history = [];       // [{ kind, label, text }] — one entry per line
    this._current = null;     // the entry currently being appended to
    this._backlog = document.getElementById("backlog");
    this._backlogList = document.getElementById("backlog-list");
    this._backlogOpen = false;
    document.getElementById("history-toggle")?.addEventListener("click", () => this.openBacklog());
    document.getElementById("backlog-close")?.addEventListener("click", () => this.closeBacklog());
    this._backlog?.addEventListener("click", (e) => {
      if (e.target === this._backlog) this.closeBacklog(); // click the dim backdrop
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._backlogOpen) this.closeBacklog();
    });
  }

  _setSpeaker(label, kind) {
    this._speaker = kind;
    if (this._name) {
      this._name.textContent = label;
      this._name.className = kind === "user" ? "user" : "";
    }
  }

  /** Show the user's line (their message, or a voice transcript). */
  addUserMessage(text) {
    this._setSpeaker("You", "user");
    this._text.textContent = text;
    this._freshReply = false;
    this._current = { kind: "user", label: "You", text };
    this._pushHistory(this._current);
    this._reveal();
  }

  /** The next segment starts a fresh Kanee line. */
  newReply() {
    this._freshReply = true;
  }

  /** Append one segment to Kanee's current line (her reply streams in). */
  addSegment({ text }) {
    if (this._freshReply || this._speaker !== "kanee") {
      this._setSpeaker(this._characterName, "kanee");
      this._text.textContent = "";
      this._freshReply = false;
      this._current = { kind: "kanee", label: this._characterName, text: "" };
      this._pushHistory(this._current);
    }
    this._text.textContent += (this._text.textContent ? " " : "") + text;
    if (this._current) this._current.text += (this._current.text ? " " : "") + text;
    if (this._backlogOpen) this._renderBacklog(); // keep an open panel live
    this._reveal();
  }

  // -- history / backlog -------------------------------------------------------

  _pushHistory(entry) {
    this._history.push(entry);
    if (this._history.length > 200) this._history.shift(); // cap memory
  }

  openBacklog() {
    this._renderBacklog();
    this._backlog.hidden = false;
    this._backlogOpen = true;
  }

  closeBacklog() {
    this._backlog.hidden = true;
    this._backlogOpen = false;
  }

  _renderBacklog() {
    this._backlogList.replaceChildren();
    if (this._history.length === 0) {
      const p = document.createElement("p");
      p.className = "backlog-empty";
      p.textContent = "No conversation yet.";
      this._backlogList.appendChild(p);
      return;
    }
    for (const entry of this._history) {
      const row = document.createElement("div");
      row.className = `backlog-row ${entry.kind}`;
      const name = document.createElement("span");
      name.className = "backlog-name";
      name.textContent = entry.label;
      const body = document.createElement("span");
      body.className = "backlog-body";
      body.textContent = entry.text;
      row.append(name, body);
      this._backlogList.appendChild(row);
    }
    this._backlogList.scrollTop = this._backlogList.scrollHeight;
  }

  _reveal() {
    this._text.classList.remove("seg-in");
    void this._text.offsetWidth; // restart the subtle fade-in
    this._text.classList.add("seg-in");
    this._text.scrollTop = this._text.scrollHeight;
  }

  setState(value) {
    this._state.textContent = value;
    this._state.className = `chip ${value}`;
  }

  setConnected(ok) {
    this._conn.textContent = ok ? "online" : "offline";
    this._conn.className = ok ? "chip ok" : "chip";
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
}
