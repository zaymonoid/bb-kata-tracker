// Nested / flat rows for the issue list, like `kata tui`'s list: children sit
// under their parent with box-drawing guides. A child whose parent is not in
// the list (closed, or in another project) is a root. Pure, so it is unit
// tested; the panel memoizes it per list/expansion/filter change.
import type { KataIssue } from "./kata-types";

export interface TreeRow {
  issue: KataIssue;
  depth: number;
  /** Box-drawing prefix for nested rows, e.g. "│  └─ "; "" for roots. */
  guide: string;
  /** Uid of the parent row, or null for a root. */
  parentUid: string | null;
  /** Children in the list (ignores the filter). */
  childCount: number;
  expanded: boolean;
  /** False for an ancestor shown only because a descendant matched. */
  match: boolean;
}

export interface TreeOptions {
  nested: boolean;
  /** Parent uids whose children are shown. Everything starts collapsed. */
  expanded: ReadonlySet<string>;
  /** Live filter; whitespace-separated terms must all match. */
  filter?: string;
}

/** Terms match title, labels, short id or qualified id, case-insensitively. */
export function matchesFilter(issue: KataIssue, filter: string): boolean {
  const terms = filter.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [issue.title, issue.short_id, issue.qualified_id, ...(issue.labels ?? [])]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Parent uid within `issues` for every issue that has one there. */
export function parentMap(issues: readonly KataIssue[]): Map<string, string> {
  const present = new Set(issues.map((issue) => issue.uid));
  const parents = new Map<string, string>();
  for (const issue of issues) {
    const parent = issue.parent?.uid;
    if (parent !== undefined && parent !== issue.uid && present.has(parent)) {
      parents.set(issue.uid, parent);
    }
  }
  // Break any cycle (kata forbids them, but a stale list must not hang us).
  for (const start of [...parents.keys()]) {
    const seen = new Set<string>([start]);
    let at = parents.get(start);
    while (at !== undefined) {
      if (seen.has(at)) {
        parents.delete(start);
        break;
      }
      seen.add(at);
      at = parents.get(at);
    }
  }
  return parents;
}

/** Uids of issues that have children in the list (for "expand all"). */
export function parentUids(issues: readonly KataIssue[]): string[] {
  return [...new Set(parentMap(issues).values())];
}

export function buildRows(issues: readonly KataIssue[], options: TreeOptions): TreeRow[] {
  const filter = options.filter?.trim() ?? "";
  const matched = (issue: KataIssue) => filter === "" || matchesFilter(issue, filter);

  if (!options.nested) {
    return issues.filter(matched).map((issue) => ({
      issue,
      depth: 0,
      guide: "",
      parentUid: null,
      childCount: 0,
      expanded: false,
      match: true,
    }));
  }

  const parents = parentMap(issues);
  const children = new Map<string, KataIssue[]>();
  const roots: KataIssue[] = [];
  for (const issue of issues) {
    const parent = parents.get(issue.uid);
    if (parent === undefined) roots.push(issue);
    else {
      const siblings = children.get(parent);
      if (siblings) siblings.push(issue);
      else children.set(parent, [issue]);
    }
  }

  // With a filter, show matches plus their ancestors, ancestors opened.
  let visible: Set<string> | null = null;
  const forced = new Set<string>();
  if (filter !== "") {
    visible = new Set();
    for (const issue of issues) {
      if (!matched(issue)) continue;
      visible.add(issue.uid);
      for (let at = parents.get(issue.uid); at !== undefined; at = parents.get(at)) {
        visible.add(at);
        forced.add(at);
      }
    }
  }

  const rows: TreeRow[] = [];
  const walk = (list: KataIssue[], depth: number, trail: string, parentUid: string | null) => {
    const shown = visible === null ? list : list.filter((issue) => visible.has(issue.uid));
    shown.forEach((issue, index) => {
      const last = index === shown.length - 1;
      const kids = children.get(issue.uid) ?? [];
      const expanded = kids.length > 0 && (forced.has(issue.uid) || options.expanded.has(issue.uid));
      rows.push({
        issue,
        depth,
        guide: depth === 0 ? "" : `${trail}${last ? "└─ " : "├─ "}`,
        parentUid,
        childCount: kids.length,
        expanded,
        match: visible === null || matched(issue),
      });
      if (expanded) {
        walk(kids, depth + 1, depth === 0 ? "" : `${trail}${last ? "   " : "│  "}`, issue.uid);
      }
    });
  };
  walk(roots, 0, "", null);
  return rows;
}

/**
 * The row to select for `uid`: itself when visible, else its closest visible
 * ancestor (it was collapsed away), else null.
 */
export function visibleRowFor(
  uid: string,
  rows: readonly TreeRow[],
  issues: readonly KataIssue[],
): string | null {
  const shown = new Set(rows.map((row) => row.issue.uid));
  const parents = parentMap(issues);
  for (let at: string | undefined = uid; at !== undefined; at = parents.get(at)) {
    if (shown.has(at)) return at;
  }
  return null;
}
