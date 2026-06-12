/**
 * Dual input: text chat box + hold-to-talk (button or Spacebar).
 *
 * Voice: pointer down (or Space down) starts a MediaRecorder; release stops
 * it and hands the recording to `onAudio` as base64. Recordings shorter than
 * 300 ms are treated as accidental taps and dropped. Mic denial surfaces via
 * `onMicError` — typing must keep working regardless.
 */
export function initInput({ onText, onAudio, onHoldStart, onHoldEnd, onMicError }) {
  const textEl = document.getElementById("text");
  const sendEl = document.getElementById("send");
  const talkEl = document.getElementById("talk");

  // -- text ------------------------------------------------------------------

  function submit() {
    const text = textEl.value.trim();
    if (!text) return;
    textEl.value = "";
    onText(text);
  }
  sendEl.addEventListener("click", submit);
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  // -- hold-to-talk ----------------------------------------------------------

  let holding = false;
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;

  async function startHold() {
    if (holding) return;
    holding = true;
    talkEl.classList.add("recording");
    onHoldStart();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      stopHoldUI();
      onMicError("Microphone access was denied — voice input is off, but you can still type.");
      return;
    }
    if (!holding) {
      // Released before permission resolved — discard.
      releaseStream();
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const mime = recorder.mimeType || "audio/webm";
      recorder = null;
      releaseStream();
      const duration = performance.now() - startedAt;
      const blob = new Blob(chunks, { type: mime });
      chunks = [];
      if (duration < 300 || blob.size === 0) return; // accidental tap
      onAudio(await blobToBase64(blob));
    };
    startedAt = performance.now();
    recorder.start();
  }

  function endHold() {
    if (!holding) return;
    holding = false;
    stopHoldUI();
    if (recorder && recorder.state === "recording") {
      recorder.stop(); // onstop releases the stream
    } else {
      releaseStream();
    }
  }

  function stopHoldUI() {
    holding = false;
    talkEl.classList.remove("recording");
    onHoldEnd();
  }

  function releaseStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  talkEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startHold();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    talkEl.addEventListener(ev, endHold);
  }
  talkEl.addEventListener("contextmenu", (e) => e.preventDefault());

  // Spacebar = push-to-talk, except while typing in the text box.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat || document.activeElement === textEl) return;
    e.preventDefault();
    startHold();
  });
  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || document.activeElement === textEl) return;
    e.preventDefault();
    endHold();
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
