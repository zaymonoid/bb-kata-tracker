// Pure moves within the tab order (`includedProjects`), shared by the tab
// strip's drag and keyboard reorder and the picker's arrows. Every function
// returns the array it was given when nothing moves, so a caller can skip the
// save.

/** Move `uid` to `index` (clamped to the list). */
export function moveTo(order: readonly string[], uid: string, index: number): readonly string[] {
  const from = order.indexOf(uid);
  if (from < 0 || order.length === 0 || !Number.isFinite(index)) return order;
  const to = Math.min(Math.max(Math.trunc(index), 0), order.length - 1);
  if (to === from) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, uid);
  return next;
}

/**
 * Drop `uid` into the gap `slot`, counted in the list as it is now: 0 is
 * before the first tab, `order.length` after the last. The two gaps around
 * `uid` itself are no-ops.
 */
export function moveToSlot(order: readonly string[], uid: string, slot: number): readonly string[] {
  const from = order.indexOf(uid);
  if (from < 0 || !Number.isFinite(slot)) return order;
  const gap = Math.min(Math.max(Math.trunc(slot), 0), order.length);
  return moveTo(order, uid, gap > from ? gap - 1 : gap);
}

/** One place left (`-1`) or right (`1`); at the ends nothing moves. */
export function shiftBy(order: readonly string[], uid: string, delta: number): readonly string[] {
  const from = order.indexOf(uid);
  if (from < 0 || !Number.isFinite(delta)) return order;
  const to = from + Math.trunc(delta);
  if (to < 0 || to >= order.length) return order;
  return moveTo(order, uid, to);
}
