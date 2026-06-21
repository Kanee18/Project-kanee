/** Landing home: hero, features, pricing, FAQ, and the beta call-to-action. */
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext.jsx";
import { useUI } from "../ui.jsx";
import { CHAT_URL, BETA_CONTACT } from "../../../shared/firebase-config.js";
import { Mic, Sparkle, Brain, Gamepad, Chat, Heart, Check, ArrowRight, Logo } from "../icons.jsx";

const contactHref = `mailto:${BETA_CONTACT}?subject=${encodeURIComponent(
  "Kanee beta access request"
)}&body=${encodeURIComponent("Hi! I'd love to try Kanee. My account email is: ")}`;

const FEATURES = [
  { icon: Mic, title: "Real voice, low latency", body: "She starts speaking within seconds — replies stream sentence by sentence in a natural synthesized voice." },
  { icon: Sparkle, title: "Expressive animation", body: "Lip-sync, emotion crossfades, gesture clips, and procedural body language. She bounces, tilts, pouts, and leans in." },
  { icon: Brain, title: "Remembers you", body: "Long-term memory of the things that matter to you, carried across conversations — not just the current chat." },
  { icon: Gamepad, title: "Game-aware", body: "Notices when you launch a game and reacts — cheering you on, teasing, or welcoming you back when you're done." },
  { icon: Chat, title: "Voice or text", body: "Hold to talk, or just type. Both are first-class — pick whatever fits the moment." },
  { icon: Heart, title: "A real personality", body: "Playful, caring, a little tsundere. She teases, sulks, and lights up — moods that shift with the conversation." },
];

const PLANS = [
  {
    name: "Beta", price: "Free", per: "", sub: "While we're in private beta",
    feats: ["Full voice + text chat", "Expressive 3D avatar", "Long-term memory", "Game-aware reactions"],
    cta: "request", featured: false,
  },
  {
    name: "Pro", price: "$9", per: "/mo", sub: "For everyday companionship", flag: "At launch",
    feats: ["Everything in Beta", "Priority voice latency", "Outfit & emote packs", "Longer memory horizon"],
    cta: "soon", featured: true,
  },
  {
    name: "Supporter", price: "$19", per: "/mo", sub: "Back the project, get extras",
    feats: ["Everything in Pro", "Early access to new features", "Custom voice options", "Direct line to the dev"],
    cta: "soon", featured: false,
  },
];

const FAQS = [
  { q: "What is Kanee, exactly?", a: "A 3D anime AI companion that runs in your browser. You talk to her by voice or text and she replies out loud while her avatar animates in real time." },
  { q: "How do I get in during the beta?", a: "Create an account, then contact us to request access. Once you're approved, the “Start chat with Kanee” button unlocks on your account." },
  { q: "Does it cost anything right now?", a: "No — the beta is completely free. Paid monthly plans only go live at launch, and beta testers get a heads-up first." },
  { q: "Do I need a powerful PC?", a: "The avatar renders in your browser, so a reasonably modern machine with a decent GPU gives the smoothest experience. It still works without one, just less buttery." },
  { q: "Is my data private?", a: "Your account is managed through Firebase. Conversations power Kanee's memory so she can remember you between chats. We don't sell your data." },
];

function HeroCta() {
  const { user, hasAccess, loading } = useAuth();
  const { openAuth } = useUI();

  if (!loading && user && hasAccess) {
    return (
      <div className="hero-cta">
        <button className="btn solid lg" onClick={() => window.open(CHAT_URL, "_blank", "noopener")}>
          Start chat with Kanee <ArrowRight width={18} height={18} />
        </button>
        <Link className="btn ghost lg" to="/account">Your account</Link>
      </div>
    );
  }
  if (!loading && user && !hasAccess) {
    return (
      <div className="hero-cta">
        <button className="btn solid lg" disabled>Awaiting beta approval</button>
        <a className="btn ghost lg" href={contactHref}>Contact for access</a>
      </div>
    );
  }
  return (
    <div className="hero-cta">
      <button className="btn solid lg" onClick={() => openAuth("signup")}>Request beta access</button>
      <a className="btn ghost lg" href="#features">See what she does</a>
    </div>
  );
}

function Portrait() {
  return (
    <div className="portrait" aria-hidden="true">
      <div className="portrait-glow" />
      <div className="portrait-frame">
        {/* Drop a transparent render at landing/public/character-hero.png to
            replace the fallback below — it appears automatically. */}
        <img
          src="/character-hero.png"
          alt=""
          className="portrait-img"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
        <div className="portrait-fallback">
          <span className="portrait-mark"><Logo width={30} height={30} /></span>
          <span className="portrait-name">Kanee</span>
          <span className="portrait-tag">your companion</span>
        </div>
        <div className="portrait-badge"><span className="dot live" /> Live · voice + text</div>
        <div className="portrait-chip">
          <span className="who">Kanee</span>
          <p>…What, I wasn't waiting or anything.</p>
        </div>
      </div>
    </div>
  );
}

function PlanCard({ plan }) {
  const { openAuth } = useUI();
  return (
    <article className={`plan${plan.featured ? " featured" : ""}`}>
      {plan.flag && <span className="plan-flag">{plan.flag}</span>}
      <div className="plan-name">{plan.name}</div>
      <div className="plan-price">
        <span className="amt">{plan.price}</span>
        {plan.per && <span className="per">{plan.per}</span>}
      </div>
      <p className="plan-sub">{plan.sub}</p>
      <ul className="plan-feats">
        {plan.feats.map((f) => (
          <li key={f}><Check width={16} height={16} /> {f}</li>
        ))}
      </ul>
      {plan.cta === "request" ? (
        <button className="btn solid full" onClick={() => openAuth("signup")}>Request access</button>
      ) : (
        <button className="btn ghost full" disabled>Coming soon</button>
      )}
    </article>
  );
}

export default function Home() {
  const { user, hasAccess } = useAuth();
  const { openAuth } = useUI();

  return (
    <>
      {/* hero */}
      <section className="hero" id="home">
        <div className="hero-text">
          <span className="eyebrow"><span className="dot" /> Private beta · free to try</span>
          <h1>Meet <span className="grad">Kanee</span>, a 3D companion who actually feels alive.</h1>
          <p className="lead">
            Talk by voice or type — Kanee replies in a real synthesized voice while her avatar
            lip-syncs, emotes, and reacts. She remembers you, has moods, and even notices when
            you fire up a game.
          </p>
          <HeroCta />
          <ul className="hero-trust">
            <li><Check width={15} height={15} /> No card required</li>
            <li><Check width={15} height={15} /> Voice &amp; text</li>
            <li><Check width={15} height={15} /> Runs in your browser</li>
          </ul>
        </div>
        <Portrait />
      </section>

      {/* features */}
      <section className="section" id="features">
        <div className="section-head">
          <span className="kicker">Features</span>
          <h2>Not a chatbot in a box.</h2>
          <p>Every reply drives a live 3D performance — voice, face, and body in sync.</p>
        </div>
        <div className="feature-grid">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <article className="feature" key={title}>
              <span className="feature-ico"><Icon width={22} height={22} /></span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* pricing */}
      <section className="section band" id="pricing">
        <div className="section-head">
          <span className="kicker">Pricing</span>
          <h2>Simple, honest pricing.</h2>
          <p>Everything is free during the beta. Paid plans go live at launch.</p>
        </div>
        <div className="plan-grid">
          {PLANS.map((p) => <PlanCard key={p.name} plan={p} />)}
        </div>
      </section>

      {/* faq */}
      <section className="section" id="faq">
        <div className="section-head">
          <span className="kicker">FAQ</span>
          <h2>Good questions.</h2>
        </div>
        <div className="faq">
          {FAQS.map(({ q, a }) => (
            <details key={q}>
              <summary>{q}<span className="faq-mark" /></summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* beta cta */}
      <section className="section" id="beta">
        <div className="cta-panel">
          <h2>Want in on the beta?</h2>
          <p>Make an account, then reach out — we'll grant your access by hand and you're in.</p>
          <div className="cta-actions">
            {user && hasAccess ? (
              <button className="btn solid lg" onClick={() => window.open(CHAT_URL, "_blank", "noopener")}>
                Start chat with Kanee <ArrowRight width={18} height={18} />
              </button>
            ) : user ? (
              <a className="btn solid lg" href={contactHref}>Request access</a>
            ) : (
              <button className="btn solid lg" onClick={() => openAuth("signup")}>Create your account</button>
            )}
            <a className="btn ghost lg" href={contactHref}>Contact us</a>
          </div>
        </div>
      </section>
    </>
  );
}
