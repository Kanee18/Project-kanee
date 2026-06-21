/**
 * Tiny loader for the static legal pages (terms.html, privacy.html). It only
 * pulls in the shared stylesheet and fills the year + contact email so those
 * live in one place (shared/firebase-config.js).
 */
import "./styles.css";
import { BETA_CONTACT } from "../../shared/firebase-config.js";

for (const el of document.querySelectorAll("[data-year]")) {
  el.textContent = new Date().getFullYear();
}
for (const el of document.querySelectorAll("[data-contact]")) {
  el.textContent = BETA_CONTACT;
  if (el.tagName === "A") el.href = `mailto:${BETA_CONTACT}`;
}
