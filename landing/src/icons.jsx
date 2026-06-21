/* Small inline SVG icons — line style, currentColor. No emojis. */

const base = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none" };
const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export const Logo = (p) => (
  <svg {...base} {...p}>
    <path
      d="M12 21s-7-4.6-9.3-9C1 8.7 2.6 5.5 5.8 5.5c1.9 0 3.3 1.1 4.2 2.6.9-1.5 2.3-2.6 4.2-2.6 3.2 0 4.8 3.2 3.1 6.5C19 16.4 12 21 12 21z"
      fill="currentColor"
    />
  </svg>
);

export const Mic = (p) => (
  <svg {...base} {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" {...stroke} />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" {...stroke} />
  </svg>
);

export const Sparkle = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" {...stroke} />
    <path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" {...stroke} />
  </svg>
);

export const Brain = (p) => (
  <svg {...base} {...p}>
    <path d="M9 4.5A2.5 2.5 0 0 0 6.5 7 2.5 2.5 0 0 0 5 11a2.5 2.5 0 0 0 1 4.5A2.5 2.5 0 0 0 9 19a2 2 0 0 0 3-1.7V6.2A2 2 0 0 0 9 4.5z" {...stroke} />
    <path d="M15 4.5A2.5 2.5 0 0 1 17.5 7 2.5 2.5 0 0 1 19 11a2.5 2.5 0 0 1-1 4.5A2.5 2.5 0 0 1 15 19a2 2 0 0 1-3-1.7V6.2A2 2 0 0 1 15 4.5z" {...stroke} />
  </svg>
);

export const Gamepad = (p) => (
  <svg {...base} {...p}>
    <path d="M7 8h10a4 4 0 0 1 4 4l-.7 4.4A2.5 2.5 0 0 1 16 17l-1.5-2h-5L8 17a2.5 2.5 0 0 1-4.3-.6L3 12a4 4 0 0 1 4-4z" {...stroke} />
    <path d="M7.5 11v2M6.5 12h2M15.5 11.5h.01M17.5 13.5h.01" {...stroke} />
  </svg>
);

export const Chat = (p) => (
  <svg {...base} {...p}>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" {...stroke} />
  </svg>
);

export const Heart = (p) => (
  <svg {...base} {...p}>
    <path d="M12 20s-6.5-4.3-8.7-8.4C1.7 8.4 3.2 5.5 6.1 5.5c1.8 0 3 1 2.9 2.4C9.9 6.5 11 5.5 12.8 5.5c2.9 0 4.4 2.9 2.8 6.1C13.5 15.7 12 20 12 20z" {...stroke} />
  </svg>
);

export const Check = (p) => (
  <svg {...base} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7" {...stroke} />
  </svg>
);

export const ArrowRight = (p) => (
  <svg {...base} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" {...stroke} />
  </svg>
);

export const Close = (p) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" {...stroke} />
  </svg>
);

export const Menu = (p) => (
  <svg {...base} {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" {...stroke} />
  </svg>
);

export const ChevronDown = (p) => (
  <svg {...base} {...p}>
    <path d="M6 9l6 6 6-6" {...stroke} />
  </svg>
);

export const Google = (p) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...p}>
    <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.9 2.9 14.7 2 12 2 6.9 2 2.8 6.1 2.8 11.2S6.9 20.3 12 20.3c5.6 0 9.3-3.9 9.3-9.4 0-.6-.06-1.1-.15-1.6H12z" />
  </svg>
);
