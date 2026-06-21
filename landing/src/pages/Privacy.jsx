import { Link } from "react-router-dom";
import { BETA_CONTACT } from "../../../shared/firebase-config.js";

export default function Privacy() {
  const year = new Date().getFullYear();
  return (
    <article className="legal">
      <Link className="back" to="/">← Back to Kanee</Link>
      <h1>Privacy Policy</h1>
      <p className="updated">Last updated: {year} · Beta</p>

      <div className="legal-note">
        A plain-language summary of what we collect and why during the beta. This is not legal
        advice — adapt it to your jurisdiction before launch.
      </div>

      <h2>1. What we collect</h2>
      <ul>
        <li><strong>Account info</strong> — your email and display name, via Firebase Authentication (email/password or Google sign-in).</li>
        <li><strong>Conversations</strong> — what you say to Kanee and her replies, used to provide the chat and her memory features.</li>
        <li><strong>Memory facts</strong> — key things you tell her, so she can remember you between sessions.</li>
        <li><strong>Basic technical data</strong> — standard logs needed to run and debug the service.</li>
      </ul>

      <h2>2. How we use it</h2>
      <ul>
        <li>To operate the companion: transcribe speech, generate replies, and synthesize her voice.</li>
        <li>To remember context so conversations feel continuous.</li>
        <li>To manage your account and beta access.</li>
        <li>To improve and debug the service during the beta.</li>
      </ul>

      <h2>3. Third-party processors</h2>
      <p>To run Kanee we rely on a few services that may process your data:</p>
      <ul>
        <li><strong>Google Firebase</strong> — authentication and database for accounts.</li>
        <li><strong>The LLM provider</strong> configured for replies (text you send is processed to generate responses).</li>
        <li><strong>Speech processing</strong> — your audio is transcribed and a voice is synthesized for replies.</li>
      </ul>
      <p>We don't sell your personal data.</p>

      <h2>4. Local game detection</h2>
      <p>The companion can notice when you launch a game so Kanee can react. This detection runs
      locally on your machine; only the fact that a known game is running is used to phrase a
      comment — your screen is never captured.</p>

      <h2>5. Retention &amp; deletion</h2>
      <p>We keep your account and conversation data while your account is active. You can request
      deletion of your account and associated data at any time by emailing{" "}
      <a href={`mailto:${BETA_CONTACT}`}>{BETA_CONTACT}</a>.</p>

      <h2>6. Security</h2>
      <p>We use reasonable measures to protect your data, but no online service is perfectly secure.
      Please use a strong, unique password.</p>

      <h2>7. Children</h2>
      <p>Kanee isn't intended for children under 13 (or the minimum age in your country).</p>

      <h2>8. Changes</h2>
      <p>We may update this policy as the product evolves; material changes will be reflected here.</p>

      <h2>9. Contact</h2>
      <p>Privacy questions? Email <a href={`mailto:${BETA_CONTACT}`}>{BETA_CONTACT}</a>.</p>

      <p className="more"><Link className="back" to="/terms">Terms of Service →</Link></p>
    </article>
  );
}
