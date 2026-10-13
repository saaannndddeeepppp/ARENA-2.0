/**
 * Design tokens — the default (light) palette of the Galaxy theme
 * Agent reference: warm off-white background, white surfaces, soft warm
 * borders, near-black text, and the signature yellow "frontier" highlight.
 * A dark palette is kept as an explicit Appearance option.
 */
export const tokens = {
  background: "#fbfaf6",
  surface1: "#ffffff",
  surface2: "#f4f2ea",
  surface3: "#ebe8dc",
  border: "#e2ded0",
  text: "#1d1c16",
  secondary: "#6f6b5d",
  tertiary: "#9a9687",
  accent: "#8a6d00",
  accentBright: "#ffd91a",
  success: "#1d7a45",
  warn: "#946a00",
  error: "#b3372f",
  radiusSm: "8px",
  radiusMd: "12px",
  radiusLg: "16px",
  font: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
} as const;

export const darkTokens = {
  background: "#0d0e10",
  surface1: "#131518",
  surface2: "#191b1f",
  surface3: "#202328",
  border: "#282b30",
  text: "#eceef2",
  secondary: "#a1a5ad",
  tertiary: "#747983",
  accent: "#d4bb78",
} as const;
