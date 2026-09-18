// utils/theme.ts
//
// The app's colour layer.
//
// Every screen in BondED hardcodes its colours — roughly 3,650 hex literals
// across 58 stylesheets, and 609 distinct values, many of which are the same
// intent written slightly differently (#fffaf7 and #fffaf6; #4d1b17, #4c1b14
// and #4d1510). This module is the single place those meanings now live, so a
// screen asks for `surface` rather than for a particular cream.
//
// Tokens are named for what they MEAN, never for what colour they are. A
// token called `cream` would be a lie in most of the themes below.
//
// NOT related to `themeColor` in utils/directMessages.ts — that is the colour
// a user picks for one conversation's bubbles, and it keeps working
// unchanged in every appearance here.

export type ThemeId =
  | "system"
  | "light"
  | "dim"
  | "midnight"
  | "sepia"
  // The campus colour themes: light palettes in other academic colours.
  | "forest"
  | "navy"
  | "teal"
  | "plum"
  | "terracotta";

/** The palette a screen actually renders with. "system" resolves to one of these. */
export type ResolvedThemeId = Exclude<ThemeId, "system">;

export type ThemeTokens = {
  /** Behind everything. */
  background: string;
  /** Cards, bubbles, rows — one step up from the background. */
  surface: string;
  /** A second step up: inputs, pressed rows, nested cards. */
  surfaceRaised: string;
  /** Sunken areas: the other person's chat bubble, code blocks. */
  surfaceSunken: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  /**
   * Text and icons on a `primary` fill — a filled button, your own chat
   * bubble, a solid badge. Light in every theme, because `primary` is a
   * mid-to-dark colour everywhere.
   */
  onPrimary: string;
  /**
   * Text and icons on an `accent` fill. Dark in every theme: the accent is
   * a light gold in all of them, so this is the one place the ink inverts.
   *
   * Splitting this from `onPrimary` matters. A single "text on a coloured
   * thing" token has to be light for the maroon and dark for the gold, and
   * whichever it picks is wrong half the time.
   */
  onAccent: string;

  border: string;
  /** Strong divider, and the outline of a focused input. */
  borderStrong: string;

  /**
   * The app bars: tab bar, screen headers, the drawer.
   *
   * Kept separate from `primary` because the two pull apart in the dark
   * themes. There, `primary` is lifted to a bright red so it can be read
   * as ink on a dark card — which is exactly the wrong colour for a bar
   * that spans the screen. `chrome` stays a surface in every theme: deep
   * maroon where the app is light, near-black where it is dark.
   */
  chrome: string;
  /** Text and icons on `chrome`. */
  onChrome: string;
  /** The same, dimmed: an inactive tab, a header subtitle. */
  onChromeMuted: string;
  /** The hairline where `chrome` meets the content. */
  chromeBorder: string;

  /** The app's identity colour — headers, primary buttons. */
  primary: string;
  /** The warm highlight — badges, active tabs, the send button. */
  accent: string;

  danger: string;
  success: string;
  warning: string;
  info: string;

  /** A wash of `accent` — chips, highlighted rows, soft badges. */
  accentSoft: string;
  /** A wash of `success`. */
  successSoft: string;
  /** A wash of `danger`. */
  dangerSoft: string;

  /** Behind a modal. */
  scrim: string;
  /** Skeleton placeholder blocks. */
  skeleton: string;

  /** Drives the status bar and any native surface. */
  statusBarStyle: "light" | "dark";
  isDark: boolean;
};

// ── Light ────────────────────────────────────────────────────────────────
// The app as it looks today. These are the values already most used across
// the codebase, so migrating a screen to tokens should change nothing.
const light: ThemeTokens = {
  background: "#fffaf6",
  surface: "#fffaf7",
  surfaceRaised: "#ffffff",
  surfaceSunken: "#f6f1ed",

  textPrimary: "#4d1b17",
  textSecondary: "#7a3b2e",
  textMuted: "#9b766c",
  onPrimary: "#fffaf6",
  onAccent: "#4d1b17",

  border: "#f0e7e2",
  borderStrong: "#ead7cf",

  chrome: "#5f0909",
  onChrome: "#fffaf6",
  onChromeMuted: "#e7cdbf",
  chromeBorder: "#7f2220",
  primary: "#5f0909",
  accent: "#e0a53d",

  danger: "#a8201a",
  success: "#2e8b68",
  warning: "#b26a10",
  info: "#1d4ed8",

  accentSoft: "#fbedd5",
  successSoft: "#e7f8ec",
  dangerSoft: "#fdecea",

  scrim: "rgba(32,16,12,0.55)",
  skeleton: "#f0e7e2",

  statusBarStyle: "dark",
  isDark: false,
};

// ── Dim ──────────────────────────────────────────────────────────────────
// A soft dark that keeps the app's warmth — brown-tinted rather than neutral
// grey, so it still reads as BondED. The default dark choice, and the one
// that is comfortable in a lit room.
const dim: ThemeTokens = {
  background: "#1c1512",
  surface: "#261d19",
  surfaceRaised: "#312621",
  surfaceSunken: "#171110",

  textPrimary: "#f5e9e3",
  textSecondary: "#d8c0b6",
  textMuted: "#a58c83",
  onPrimary: "#fdf3ef",
  onAccent: "#1c1512",

  border: "#3a2c26",
  borderStrong: "#4a382f",

  // Lifted well above the light theme's maroon: #5f0909 on a dark ground is
  // nearly invisible, so the identity colour is re-pitched rather than reused.
  chrome: "#241b17",
  onChrome: "#f5e9e3",
  onChromeMuted: "#a58c83",
  chromeBorder: "#3a2c26",
  primary: "#c9564a",
  accent: "#e8b45c",

  danger: "#f0736a",
  success: "#5cc79c",
  warning: "#e0a53d",
  info: "#7ba7f5",

  accentSoft: "#3a2c1c",
  successSoft: "#1c3a2c",
  dangerSoft: "#3a1f1c",

  scrim: "rgba(0,0,0,0.65)",
  skeleton: "#2e231e",

  statusBarStyle: "light",
  isDark: true,
};

// ── Midnight ─────────────────────────────────────────────────────────────
// True black. On the OLED screens most phones now ship, black pixels are
// switched off entirely, so this genuinely saves battery — and it is the one
// people reach for in a dark room.
const midnight: ThemeTokens = {
  background: "#000000",
  surface: "#0d0b0a",
  surfaceRaised: "#171413",
  surfaceSunken: "#000000",

  textPrimary: "#f7efeb",
  textSecondary: "#cfb8ae",
  textMuted: "#9b8279",
  onPrimary: "#fff7f3",
  onAccent: "#14100e",

  border: "#231e1c",
  borderStrong: "#332b28",

  chrome: "#0a0908",
  onChrome: "#f7efeb",
  onChromeMuted: "#9b8279",
  chromeBorder: "#231e1c",
  primary: "#d96355",
  accent: "#eebc63",

  danger: "#ff7d73",
  success: "#5fd3a4",
  warning: "#e8b45c",
  info: "#86aef7",

  accentSoft: "#241c0f",
  successSoft: "#0f2419",
  dangerSoft: "#240f0f",

  scrim: "rgba(0,0,0,0.78)",
  skeleton: "#1a1615",

  statusBarStyle: "light",
  isDark: true,
};

// ── Sepia ────────────────────────────────────────────────────────────────
// Warm and low-contrast, with the blue pulled out. For reading at night
// without the glare of the light theme — the campus equivalent of an
// e-reader's night mode. Still a light theme, so text stays dark.
const sepia: ThemeTokens = {
  background: "#f4e8d5",
  surface: "#faf0e0",
  surfaceRaised: "#fff8ec",
  surfaceSunken: "#ecdcc4",

  textPrimary: "#3f2d1c",
  textSecondary: "#6b4e33",
  textMuted: "#957a5c",
  onPrimary: "#faf0e0",
  onAccent: "#3f2d1c",

  border: "#e0cdb0",
  borderStrong: "#cdb391",

  chrome: "#7a2f16",
  onChrome: "#faf0e0",
  onChromeMuted: "#e0c9a8",
  chromeBorder: "#96482a",
  primary: "#7a2f16",
  accent: "#b9812c",

  danger: "#a33b22",
  success: "#4a7c52",
  warning: "#9a6a17",
  info: "#3c5c8a",

  accentSoft: "#f0dcb4",
  successSoft: "#dde8d4",
  dangerSoft: "#f0d8cd",

  scrim: "rgba(48,34,20,0.55)",
  skeleton: "#e6d5bb",

  statusBarStyle: "dark",
  isDark: false,
};

// ── Campus colours ───────────────────────────────────────────────────────
// Five light palettes in other academic colours, for people who want BondED
// in something other than maroon. Each keeps the app's shape — a dark bar,
// white cards on a tinted page, a gold accent — and changes the colour, so
// they read as the same app. None has a dark version; like Light and Sepia
// they stay light, and "Use system" still chooses between Light and Dim.
//
// Every text colour here clears 4.5:1 against the surface it sits on. Each
// palette's warning is a deeper amber than a highlight would be, because it
// is used for words ("Pending review"), not just fills.

// Deep forest green and warm gold — a library, not an eco brand.
const forest: ThemeTokens = {
  background: "#F5F4EC",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  surfaceSunken: "#EDF1EE",

  textPrimary: "#17241E",
  textSecondary: "#38463F",
  textMuted: "#607068",
  onPrimary: "#FFFFFF",
  onAccent: "#17241E",

  border: "#D7E0DA",
  borderStrong: "#BDC7C1",

  chrome: "#234E3B",
  onChrome: "#FFFFFF",
  onChromeMuted: "#CFD8D4",
  chromeBorder: "#426756",
  primary: "#234E3B",
  accent: "#D2A74A",

  danger: "#B84747",
  success: "#2E7D55",
  warning: "#9C6D20",
  info: "#2F6690",

  accentSoft: "#F6EDDB",
  successSoft: "#E6EFEB",
  dangerSoft: "#F8EDED",

  scrim: "rgba(23,36,30,0.55)",
  skeleton: "#E8EEE9",

  statusBarStyle: "dark",
  isDark: false,
};

// Institutional navy and muted gold. Named for the colour rather than the
// hour, so nobody mistakes it for a dark mode next to Midnight.
const navy: ThemeTokens = {
  background: "#F4F6F8",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  surfaceSunken: "#EEF1F5",

  textPrimary: "#17202B",
  textSecondary: "#3B4552",
  textMuted: "#636F7E",
  onPrimary: "#FFFFFF",
  onAccent: "#17202B",

  border: "#D8DFE7",
  borderStrong: "#BFC7D1",

  chrome: "#162A46",
  onChrome: "#FFFFFF",
  onChromeMuted: "#CCD0D6",
  chromeBorder: "#374860",
  primary: "#162A46",
  accent: "#D3A74F",

  danger: "#C25151",
  success: "#338469",
  warning: "#9B6E28",
  info: "#2E63A6",

  accentSoft: "#F6EDDC",
  successSoft: "#E7F0ED",
  dangerSoft: "#F9EEEE",

  scrim: "rgba(23,32,43,0.55)",
  skeleton: "#E9EDF2",

  statusBarStyle: "dark",
  isDark: false,
};

// A dark, contemporary teal with gold. Its success is a truer green than
// the palette's own teal, or "online" would disappear into the branding.
const teal: ThemeTokens = {
  background: "#F4F8F7",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  surfaceSunken: "#EAF2F0",

  textPrimary: "#172725",
  textSecondary: "#394A48",
  textMuted: "#5E716E",
  onPrimary: "#FFFFFF",
  onAccent: "#172725",

  border: "#CEE0DD",
  borderStrong: "#B6C8C5",

  chrome: "#176B67",
  onChrome: "#FFFFFF",
  onChromeMuted: "#CCDEDE",
  chromeBorder: "#37807C",
  primary: "#176B67",
  accent: "#D6A84D",

  danger: "#BB4C52",
  success: "#357A3B",
  warning: "#986D26",
  info: "#2F63A0",

  accentSoft: "#F7EEDB",
  successSoft: "#E7EFE7",
  dangerSoft: "#F8EDEE",

  scrim: "rgba(23,39,37,0.55)",
  skeleton: "#E3EFED",

  statusBarStyle: "dark",
  isDark: false,
};

// Deep plum and antique gold — academic robes, not violet.
const plum: ThemeTokens = {
  background: "#F8F5F7",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  surfaceSunken: "#F1EDF2",

  textPrimary: "#2A222D",
  textSecondary: "#4B424F",
  textMuted: "#736878",
  onPrimary: "#FFFFFF",
  onAccent: "#2A222D",

  border: "#DED5E0",
  borderStrong: "#C7BDC9",

  chrome: "#573B63",
  onChrome: "#FFFFFF",
  onChromeMuted: "#DAD4DD",
  chromeBorder: "#6F5679",
  primary: "#573B63",
  accent: "#D3A552",

  danger: "#B74B55",
  success: "#39795A",
  warning: "#9A6D29",
  info: "#3A62A0",

  accentSoft: "#F6EDDC",
  successSoft: "#E7EFEB",
  dangerSoft: "#F8EDEE",

  scrim: "rgba(42,34,45,0.55)",
  skeleton: "#EEE8EF",

  statusBarStyle: "dark",
  isDark: false,
};

// Brick clay and ochre on parchment. Lighter and rosier than Sepia's rust
// so the two don't look alike, and with a crimson danger so a delete button
// never passes for a normal one.
const terracotta: ThemeTokens = {
  background: "#F8F3EC",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  surfaceSunken: "#F2EAE3",

  textPrimary: "#30231F",
  textSecondary: "#4F403A",
  textMuted: "#75635C",
  onPrimary: "#FFFFFF",
  onAccent: "#30231F",

  border: "#E1D5CC",
  borderStrong: "#C9BCB3",

  chrome: "#9C5444",
  onChrome: "#FFFFFF",
  onChromeMuted: "#F0E5E3",
  chromeBorder: "#AA6C5E",
  primary: "#9C5444",
  accent: "#C99A45",

  danger: "#B0304A",
  success: "#55775A",
  warning: "#9F6C26",
  info: "#3B5F8F",

  accentSoft: "#F4EBDA",
  successSoft: "#EBEFEB",
  dangerSoft: "#F7EAED",

  scrim: "rgba(48,35,31,0.55)",
  skeleton: "#EFE5DC",

  statusBarStyle: "dark",
  isDark: false,
};

export const THEMES: Record<ResolvedThemeId, ThemeTokens> = {
  light,
  dim,
  midnight,
  sepia,
  forest,
  navy,
  teal,
  plum,
  terracotta,
};

export type ThemeOption = {
  id: ThemeId;
  label: string;
  description: string;
  icon: string;
  /**
   * The group it is listed under in Settings: the brightness choices the app
   * has always had, or the campus colours.
   */
  group: "brightness" | "campus";
  /**
   * Three colours that identify it, shown as dots in Settings. Brightness
   * themes show their background, surface and accent; campus themes show
   * their bar colour, accent and background, since the bar is what changes.
   */
  swatch: [string, string, string];
};

/**
 * What Settings shows, in this order.
 *
 * "Use system" first because it is the right answer for most people and the
 * one that needs no thought. The brightness themes run light to dark, so the
 * list reads as a scale rather than an unordered set; the campus colours
 * follow as their own group.
 */
export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "system",
    label: "Use system",
    description: "Follows your phone's light or dark setting",
    icon: "phone-portrait-outline",
    group: "brightness",
    swatch: [light.background, midnight.background, light.accent],
  },
  {
    id: "light",
    label: "Light",
    description: "The usual warm cream",
    icon: "sunny-outline",
    group: "brightness",
    swatch: [light.background, light.surfaceSunken, light.accent],
  },
  {
    id: "sepia",
    label: "Sepia",
    description: "Warm and easy on the eyes for reading at night",
    icon: "book-outline",
    group: "brightness",
    swatch: [sepia.background, sepia.surfaceSunken, sepia.accent],
  },
  {
    id: "dim",
    label: "Dim",
    description: "Soft dark that keeps the app's warmth",
    icon: "moon-outline",
    group: "brightness",
    swatch: [dim.background, dim.surfaceRaised, dim.accent],
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "True black — saves battery on OLED screens",
    icon: "contrast-outline",
    group: "brightness",
    swatch: [midnight.background, midnight.surfaceRaised, midnight.accent],
  },
  {
    id: "forest",
    label: "Forest Scholar",
    description: "Library green and warm gold",
    icon: "leaf-outline",
    group: "campus",
    swatch: [forest.chrome, forest.accent, forest.background],
  },
  {
    id: "navy",
    label: "Campus Navy",
    description: "Institutional navy and muted gold",
    icon: "school-outline",
    group: "campus",
    swatch: [navy.chrome, navy.accent, navy.background],
  },
  {
    id: "teal",
    label: "Campus Teal",
    description: "Fresh, modern teal and gold",
    icon: "water-outline",
    group: "campus",
    swatch: [teal.chrome, teal.accent, teal.background],
  },
  {
    id: "plum",
    label: "Academic Plum",
    description: "Deep plum and antique gold",
    icon: "color-palette-outline",
    group: "campus",
    swatch: [plum.chrome, plum.accent, plum.background],
  },
  {
    id: "terracotta",
    label: "Terracotta Campus",
    description: "Brick clay and ochre on parchment",
    icon: "business-outline",
    group: "campus",
    swatch: [terracotta.chrome, terracotta.accent, terracotta.background],
  },
];

/** Resolves "system" against what the OS reports. */
export function resolveTheme(
  choice: ThemeId,
  systemPrefersDark: boolean,
): ResolvedThemeId {
  if (choice !== "system") return choice;
  // "Dim" rather than "midnight" for system dark: true black is a deliberate
  // preference, not something to hand somebody who never asked for it.
  return systemPrefersDark ? "dim" : "light";
}

export const DEFAULT_THEME: ThemeId = "system";

const THEME_IDS: ReadonlySet<string> = new Set(THEME_OPTIONS.map((option) => option.id));

/**
 * Whether a stored value is a theme this build knows. Anything else — an
 * older build's leftover, a corrupted value — falls back to the default.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

/**
 * Lifts a decorative colour so it still reads on a dark surface.
 *
 * Several screens carry a fixed palette of category hues — the Dashboard's
 * stat tiles, the event calendar's types, the analytics charts. Those were
 * picked against a cream card, and a few of them (a forest green, a deep
 * teal) all but vanish on a near-black one. Rather than maintain a second
 * palette per theme, the dark themes raise the lightness of whatever they
 * are handed and leave the hue alone, so a green stays green.
 *
 * A no-op in the light themes, which is why the tokens are passed in rather
 * than a boolean: the call site reads as "this colour, on this surface".
 */
export function onSurface(hex: string, tokens: ThemeTokens): string {
  if (!tokens.isDark) return hex;

  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  // Already bright enough to carry itself.
  if (l >= 0.58) return hex;

  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const target = 0.62;
  const c = (1 - Math.abs(2 * target - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = target - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const [rr, gg, bb] = (
    [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]] as const
  )[seg];

  const hex2 = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v + mm)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex2(rr)}${hex2(gg)}${hex2(bb)}`;
}
