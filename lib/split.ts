// Pure maths for the resizable list/detail split (T9). The width is kept as a
// fraction of the panel, so it survives window and side-panel resizes; the
// minima are pixels, so they are applied against the panel width every render
// rather than once at drag time.

/** The list never gets narrower than this. */
export const MIN_LIST_PX = 280;
/** Neither does the detail. */
export const MIN_DETAIL_PX = 320;
/** What the split was before it could be dragged; double-click resets here. */
export const DEFAULT_LIST_FRACTION = 0.45;

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

/**
 * `fraction` with both minima honoured for a panel this wide. Junk, and a
 * panel too narrow to hold both minima, fall back to a fixed split (the
 * minima's own ratio in the second case, so neither pane collapses).
 */
export function clampFraction(fraction: number, panelWidth: number): number {
  const tooNarrow = !Number.isFinite(panelWidth) || panelWidth <= 0;
  const wanted = Number.isFinite(fraction) ? fraction : DEFAULT_LIST_FRACTION;
  if (tooNarrow) return clamp(wanted, 0, 1);
  const lo = MIN_LIST_PX / panelWidth;
  const hi = 1 - MIN_DETAIL_PX / panelWidth;
  if (lo >= hi) return MIN_LIST_PX / (MIN_LIST_PX + MIN_DETAIL_PX);
  return clamp(wanted, lo, hi);
}

/** The clamped list width in pixels, for a panel this wide. */
export function listWidthPx(fraction: number, panelWidth: number): number {
  return Math.round(clampFraction(fraction, panelWidth) * Math.max(panelWidth, 0));
}

/** Where a pointer at `clientX` puts the boundary, as a clamped fraction. */
export function fractionFromPointer(clientX: number, panelLeft: number, panelWidth: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(panelLeft)) return clampFraction(DEFAULT_LIST_FRACTION, panelWidth);
  return clampFraction((clientX - panelLeft) / (panelWidth || 1), panelWidth);
}

/** Two fractions that render the same at this width need no save. */
export function sameFraction(a: number, b: number, panelWidth: number): boolean {
  return listWidthPx(a, panelWidth) === listWidthPx(b, panelWidth);
}

/** A stored fraction (RPC, localStorage) that is safe to use, else null. */
export function readFraction(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0 || number >= 1) return null;
  return number;
}
