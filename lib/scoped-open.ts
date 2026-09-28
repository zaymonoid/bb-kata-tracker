// A deliberate open of a thread's "Kata issues" panel (an issue chip, the
// palette, the thread header). The request goes through the viewer store
// rather than the panel's `params`, so it also reaches a panel the host is
// already showing: clicking the same chip twice re-targets it.
import type { Pane } from "./keymap";
import type { IssueTarget } from "./refs";

export interface ScopedOpenRequest {
  at: number;
  /** The issue to show; null for "Open Kata issues", which is the whole list. */
  target: IssueTarget | null;
}

/** How long a request may wait for its panel to mount. */
export const SCOPED_OPEN_WINDOW_MS = 3000;

/**
 * Which pane the request lands a mounted thread panel on, or null when the
 * request is not that panel's. The host opens one tab per issue, so only the
 * tab whose `params` name that issue (or one with no params of its own)
 * answers a targeted request.
 */
export function scopedOpenPane(
  request: { target: IssueTarget | null },
  panel: { projectUid: string | null; target: IssueTarget | null },
): Pane | null {
  const wanted = request.target;
  if (wanted === null) return "list";
  if (panel.projectUid !== wanted.projectUid) return null;
  if (panel.target !== null && panel.target.issueUid !== wanted.issueUid) return null;
  return "detail";
}
