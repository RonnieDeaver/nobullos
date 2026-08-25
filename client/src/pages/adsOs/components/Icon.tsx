// Crisp inline line-icons (stroke = currentColor) replacing emoji glyphs, so they
// render consistently cross-platform and pick up the brand colors.
// Port of the bundle's frontend/src/components/Icon.tsx (StatusDot omitted — the
// repo has no Status band type yet; it arrives with the alerts work).

export type IconName =
  | "octagon-alert" | "alert-triangle" | "info" | "bolt" | "calendar" | "ban" | "sparkle" | "check"
  | "sun" | "moon";

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "octagon-alert":
      return (
        <svg {...p}>
          <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" />
          <line x1="12" y1="8" x2="12" y2="13" />
          <line x1="12" y1="16.5" x2="12" y2="16.5" />
        </svg>
      );
    case "alert-triangle":
      return (
        <svg {...p}>
          <path d="M12 3 22 20H2z" />
          <line x1="12" y1="9.5" x2="12" y2="14" />
          <line x1="12" y1="17" x2="12" y2="17" />
        </svg>
      );
    case "info":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11.5" x2="12" y2="16.5" />
          <line x1="12" y1="7.8" x2="12" y2="7.8" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...p}>
          <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...p}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <line x1="3" y1="9.5" x2="21" y2="9.5" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="16" y1="2" x2="16" y2="6" />
        </svg>
      );
    case "ban":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...p}>
          <path d="M12 3l2.1 6.4 6.4 2.1-6.4 2.1L12 21l-2.1-6.4L3.5 11.5l6.4-2.1z" />
        </svg>
      );
    case "check":
      return (
        <svg {...p}>
          <polyline points="4 12 10 18 20 6" />
        </svg>
      );
    case "sun":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="4.2" />
          <line x1="12" y1="2.2" x2="12" y2="4.8" />
          <line x1="12" y1="19.2" x2="12" y2="21.8" />
          <line x1="2.2" y1="12" x2="4.8" y2="12" />
          <line x1="19.2" y1="12" x2="21.8" y2="12" />
          <line x1="5.1" y1="5.1" x2="6.9" y2="6.9" />
          <line x1="17.1" y1="17.1" x2="18.9" y2="18.9" />
          <line x1="5.1" y1="18.9" x2="6.9" y2="17.1" />
          <line x1="17.1" y1="6.9" x2="18.9" y2="5.1" />
        </svg>
      );
    case "moon":
      return (
        <svg {...p}>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      );
  }
}
