/**
 * Collapsible customization sidebar: pick an outfit (swaps the VRM model) and
 * trigger an emote. Pure DOM over the static structure in index.html; the
 * actual model swap / emote playback is done by the callbacks from main.js.
 */
export class Sidebar {
  /**
   * @param onOutfit (url) => Promise|void  — swap to this outfit VRM
   * @param onEmote  (key) => void          — play this emote clip
   */
  constructor({ onOutfit, onEmote }) {
    this._onOutfit = onOutfit;
    this._onEmote = onEmote;
    this._panel = document.getElementById("sidebar");
    this._outfitList = document.getElementById("outfit-list");
    this._emoteList = document.getElementById("emote-list");
    this._activeUrl = null;
    this._busy = false;

    document.getElementById("menu-toggle")?.addEventListener("click", () => this.toggle());
    document.getElementById("side-close")?.addEventListener("click", () => this.close());
    // Esc closes the panel.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) this.close();
    });
  }

  get isOpen() {
    return this._panel?.classList.contains("open") ?? false;
  }
  open() {
    this._panel?.classList.add("open");
  }
  close() {
    this._panel?.classList.remove("open");
  }
  toggle() {
    this._panel?.classList.toggle("open");
  }

  /** Render the outfit chooser. `outfits`: [{ name, url }]. */
  setOutfits(outfits, activeUrl) {
    if (!this._outfitList) return;
    this._activeUrl = activeUrl;
    this._outfitList.replaceChildren();
    if (outfits.length === 0) {
      this._outfitList.appendChild(emptyNote("No outfits found."));
      return;
    }
    for (const { name, url } of outfits) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "side-item" + (url === activeUrl ? " active" : "");
      btn.textContent = name;
      btn.dataset.url = url;
      btn.addEventListener("click", () => this._pickOutfit(url));
      this._outfitList.appendChild(btn);
    }
  }

  async _pickOutfit(url) {
    if (this._busy || url === this._activeUrl) return;
    this._setBusy(true);
    const items = [...this._outfitList.querySelectorAll(".side-item")];
    items.forEach((b) => b.classList.toggle("loading", b.dataset.url === url));
    try {
      await this._onOutfit(url);
      this._activeUrl = url;
      items.forEach((b) => b.classList.toggle("active", b.dataset.url === url));
    } finally {
      items.forEach((b) => b.classList.remove("loading"));
      this._setBusy(false);
    }
  }

  _setBusy(on) {
    this._busy = on;
    this._outfitList?.classList.toggle("busy", on);
  }

  /** Render the emote chooser. `emotes`: [{ key, label }]. */
  setEmotes(emotes) {
    if (!this._emoteList) return;
    this._emoteList.replaceChildren();
    if (emotes.length === 0) {
      this._emoteList.appendChild(emptyNote("No emotes found."));
      return;
    }
    for (const { key, label } of emotes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "side-emote";
      btn.textContent = label;
      btn.addEventListener("click", () => this._onEmote(key));
      this._emoteList.appendChild(btn);
    }
  }
}

function emptyNote(text) {
  const p = document.createElement("p");
  p.className = "side-empty";
  p.textContent = text;
  return p;
}
