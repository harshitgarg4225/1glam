import { rgb } from "pdf-lib";

type Rgb = ReturnType<typeof rgb>;

// A document theme is a flat palette consumed by the PDF drawing helpers in
// documents.ts. Keeping it data-only means swapping a design is just picking a
// different palette — no branching logic in the renderer. The palettes are
// inspired by widely-used open-source invoice template aesthetics (warm
// classic, clean minimal, dark noir, soft blush) re-expressed for pdf-lib so we
// avoid pulling in a heavyweight HTML-to-PDF renderer.
export type DocumentTheme = {
  key: string;
  label: string;
  description: string;
  frameBorder: Rgb;
  bandBg: Rgb;
  bandText: Rgb;
  title: Rgb;
  subtitle: Rgb;
  meta: Rgb;
  sectionHeading: Rgb;
  bodyText: Rgb;
  blockBg: Rgb;
  blockBorder: Rgb;
  blockHeading: Rgb;
  blockLabel: Rgb;
  blockValue: Rgb;
  paragraph: Rgb;
  footer: Rgb;
};

const THEMES: Record<string, DocumentTheme> = {
  classic: {
    key: "classic",
    label: "Classic Gold",
    description: "Warm cream and gold — elegant and timeless.",
    frameBorder: rgb(0.77, 0.66, 0.53),
    bandBg: rgb(0.97, 0.95, 0.92),
    bandText: rgb(0.39, 0.29, 0.18),
    title: rgb(0.14, 0.1, 0.08),
    subtitle: rgb(0.32, 0.25, 0.2),
    meta: rgb(0.3, 0.3, 0.3),
    sectionHeading: rgb(0.23, 0.17, 0.12),
    bodyText: rgb(0.2, 0.2, 0.2),
    blockBg: rgb(0.985, 0.972, 0.955),
    blockBorder: rgb(0.9, 0.82, 0.7),
    blockHeading: rgb(0.23, 0.17, 0.12),
    blockLabel: rgb(0.25, 0.25, 0.25),
    blockValue: rgb(0.16, 0.16, 0.16),
    paragraph: rgb(0.22, 0.22, 0.22),
    footer: rgb(0.45, 0.45, 0.45),
  },
  minimal: {
    key: "minimal",
    label: "Minimal Mono",
    description: "Clean black-and-white, lots of whitespace.",
    frameBorder: rgb(0.86, 0.86, 0.86),
    bandBg: rgb(0.96, 0.96, 0.96),
    bandText: rgb(0.1, 0.1, 0.1),
    title: rgb(0.08, 0.08, 0.08),
    subtitle: rgb(0.35, 0.35, 0.35),
    meta: rgb(0.4, 0.4, 0.4),
    sectionHeading: rgb(0.1, 0.1, 0.1),
    bodyText: rgb(0.25, 0.25, 0.25),
    blockBg: rgb(0.975, 0.975, 0.975),
    blockBorder: rgb(0.85, 0.85, 0.85),
    blockHeading: rgb(0.1, 0.1, 0.1),
    blockLabel: rgb(0.35, 0.35, 0.35),
    blockValue: rgb(0.08, 0.08, 0.08),
    paragraph: rgb(0.3, 0.3, 0.3),
    footer: rgb(0.55, 0.55, 0.55),
  },
  noir: {
    key: "noir",
    label: "Noir",
    description: "Dark charcoal band with crisp contrast — bold and modern.",
    frameBorder: rgb(0.2, 0.2, 0.22),
    bandBg: rgb(0.11, 0.1, 0.12),
    bandText: rgb(0.93, 0.91, 0.88),
    title: rgb(0.11, 0.1, 0.12),
    subtitle: rgb(0.35, 0.34, 0.36),
    meta: rgb(0.4, 0.4, 0.42),
    sectionHeading: rgb(0.13, 0.12, 0.14),
    bodyText: rgb(0.24, 0.24, 0.26),
    blockBg: rgb(0.96, 0.96, 0.97),
    blockBorder: rgb(0.78, 0.78, 0.8),
    blockHeading: rgb(0.11, 0.1, 0.12),
    blockLabel: rgb(0.3, 0.3, 0.32),
    blockValue: rgb(0.1, 0.1, 0.11),
    paragraph: rgb(0.26, 0.26, 0.28),
    footer: rgb(0.5, 0.5, 0.52),
  },
  blush: {
    key: "blush",
    label: "Blush",
    description: "Soft terracotta and pink — friendly and on-brand.",
    frameBorder: rgb(0.85, 0.62, 0.52),
    bandBg: rgb(0.98, 0.94, 0.91),
    bandText: rgb(0.62, 0.32, 0.2),
    title: rgb(0.45, 0.22, 0.15),
    subtitle: rgb(0.5, 0.34, 0.29),
    meta: rgb(0.45, 0.4, 0.39),
    sectionHeading: rgb(0.62, 0.32, 0.2),
    bodyText: rgb(0.27, 0.24, 0.23),
    blockBg: rgb(0.99, 0.95, 0.92),
    blockBorder: rgb(0.9, 0.74, 0.66),
    blockHeading: rgb(0.62, 0.32, 0.2),
    blockLabel: rgb(0.38, 0.32, 0.3),
    blockValue: rgb(0.45, 0.22, 0.15),
    paragraph: rgb(0.3, 0.27, 0.26),
    footer: rgb(0.55, 0.48, 0.46),
  },
};

export const DOCUMENT_THEME_LIST = Object.values(THEMES).map((theme) => ({
  key: theme.key,
  label: theme.label,
  description: theme.description,
}));

export function getDocumentTheme(key: string | undefined): DocumentTheme {
  return THEMES[String(key || "").trim()] ?? THEMES.classic;
}
