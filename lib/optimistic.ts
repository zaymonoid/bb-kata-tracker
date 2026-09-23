// Optimistic list state. What the panel shows for a project is
//
//   server list  →  confirmed issues  →  lingering closes  →  pending edits
//
// `confirmed` holds issues a mutation RPC returned: they win over the server
// list until a list fetch shows the same revision or newer (the event tail
// and a slow fetch can both deliver a list from before the change). Pending
// edits are the user's in-flight mutations, applied on top; a failed one is
// simply dropped, which rolls it back. Issues closed or reopened from the
// panel linger in place (shown with their new status) so `r` can undo a
// close and a reopen does not jump rows, until the tab or status view is
// left (or the issue changes elsewhere).
// The same layering serves the open, closed and all views (`StatusView`).
// Pure, so it is unit tested.
import type { KataIssue } from "./kata-types";

export interface PendingEdit {
  id: number;
  projectUid: string;
  issueUid: string;
  /**
   * The issue as it should look while the mutation is in flight; null
   * removes it from the (open) list. `undefined` input means the issue is
   * not in the list; a create returns its placeholder then.
   */
  apply: (issue: KataIssue | undefined) => KataIssue | null | undefined;
}

/** The server copy has caught up with (or passed) the confirmed one. */
export function caughtUp(server: KataIssue, confirmed: KataIssue): boolean {
  if (server.revision !== confirmed.revision) return server.revision > confirmed.revision;
  return server.updated_at >= confirmed.updated_at;
}

export interface Reconciled {
  issues: KataIssue[];
  /** Confirmed uids the server list now reflects; the caller drops them. */
  settled: string[];
  /** Lingering rows changed elsewhere since (gone from a list that had shown them); the caller drops them. */
  unlingered: string[];
  /** The copy each remaining lingering row shows now; the caller stores it back into its entry. */
  lingered: Map<string, Lingering>;
}

/**
 * An issue changed here (closed or reopened), kept on screen at the row
 * index it had so rows never jump under the cursor. `seen`: the server list
 * has shown it as it now is; if it then leaves the list, it changed
 * elsewhere and stops lingering.
 */
export interface Lingering {
  issue: KataIssue;
  index: number;
  seen?: boolean;
}

/** Which issues a status view lists: `open` (the default), `closed`, or `all`. */
export type StatusView = "open" | "closed" | "all";

export const inView = (view: StatusView, issue: Pick<KataIssue, "status">): boolean =>
  view === "all" || issue.status === view;

export function reconcile(
  server: readonly KataIssue[],
  confirmed: ReadonlyMap<string, KataIssue>,
  pending: readonly PendingEdit[],
  lingering: ReadonlyMap<string, Lingering> = new Map(),
  view: StatusView = "open",
): Reconciled {
  const settled: string[] = [];
  const unlingered: string[] = [];
  const lingered = new Map<string, Lingering>();
  let issues: KataIssue[] = [];
  const seen = new Set<string>();
  for (const issue of server) {
    seen.add(issue.uid);
    const mine = confirmed.get(issue.uid);
    const fresh = mine === undefined || caughtUp(issue, mine);
    if (fresh && mine !== undefined) settled.push(issue.uid);
    const kept = lingering.get(issue.uid);
    if (kept) {
      // Placed at its own index below, with the freshest copy.
      const shown = fresh || mine === undefined ? issue : mine;
      lingered.set(issue.uid, { issue: shown, index: kept.index, seen: kept.seen || caughtUp(issue, kept.issue) });
      continue;
    }
    if (fresh) issues.push(issue);
    else if (inView(view, mine)) issues.push(mine);
    // else: the confirmed change moved it out of this view and the list predates it — hide it.
  }
  const added: KataIssue[] = [];
  for (const [uid, mine] of confirmed) {
    if (seen.has(uid)) continue;
    const kept = lingering.get(uid);
    if (kept) {
      if (!kept.seen) lingered.set(uid, { issue: mine, index: kept.index });
      settled.push(uid);
    } else if (inView(view, mine)) {
      added.push(mine);
    } else {
      // Out of this view and missing from it: exactly what we expect.
      settled.push(uid);
    }
  }
  for (const [uid, kept] of lingering) {
    if (lingered.has(uid) || seen.has(uid) || confirmed.has(uid)) continue;
    if (kept.seen) unlingered.push(uid);
    else lingered.set(uid, kept);
  }
  for (const uid of lingering.keys()) {
    if (!lingered.has(uid) && !unlingered.includes(uid)) unlingered.push(uid);
  }
  // Newly created issues (and ones reopened elsewhere) go on top, where the user is looking.
  if (added.length > 0) issues = [...added.reverse(), ...issues];

  for (const entry of [...lingered.values()].sort((a, b) => a.index - b.index)) {
    issues.splice(Math.min(entry.index, issues.length), 0, entry.issue);
  }

  for (const edit of pending) {
    const index = issues.findIndex((issue) => issue.uid === edit.issueUid);
    const next = edit.apply(index === -1 ? undefined : issues[index]);
    if (index === -1) {
      if (next) issues = [next, ...issues];
    } else if (next === null) {
      issues = issues.filter((_, i) => i !== index);
    } else if (next !== undefined) {
      issues = issues.map((issue, i) => (i === index ? next : issue));
    }
  }
  return { issues, settled, unlingered, lingered };
}
