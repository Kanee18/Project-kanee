/**
 * Holds the backend URL the app discovered at startup (from Firestore
 * config/runtime, published by the tunnel script). ws.js reads it when opening
 * the socket. Kept as a module variable so it doesn't collide with the manual
 * ?api= override (which lives in localStorage).
 */
let _url = "";

export function setRuntimeBackend(url) {
  _url = (url || "").trim();
}

export function getRuntimeBackend() {
  return _url;
}
