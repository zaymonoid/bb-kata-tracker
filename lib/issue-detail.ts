// `showIssue` returns the bare issue row plus its labels, links and comments
// separately; the detail pane wants the `IssueOut` shape the list uses. This
// folds one into the other. Pure, so it is unit tested.
import type {
  KataIssueDetail,
  KataLinkPeer,
  KataShowIssueResponse,
} from "./kata-types.ts";

/** Comments beyond this are dropped (newest kept) to bound the payload. */
export const MAX_COMMENTS = 100;
const MAX_CHILDREN = 200;

export function toIssueDetail(
  show: KataShowIssueResponse,
  projectName: string,
): KataIssueDetail {
  const raw = show.issue;
  const blocks: KataLinkPeer[] = [];
  const blockedBy: KataLinkPeer[] = [];
  const related: KataLinkPeer[] = [];
  let parent: KataLinkPeer | undefined = show.parent;
  for (const link of show.links ?? []) {
    const outgoing = link.from.uid === raw.uid;
    const other = outgoing ? link.to : link.from;
    switch (link.type) {
      case "parent":
        // from = child, to = parent. Incoming parent links are children,
        // which come with titles from `show.children` instead.
        if (outgoing) parent ??= other;
        break;
      case "blocks":
        (outgoing ? blocks : blockedBy).push(other);
        break;
      case "related":
        related.push(other);
        break;
    }
  }
  const children = (show.children ?? []).slice(0, MAX_CHILDREN).map(
    (child): KataLinkPeer => ({
      uid: child.uid,
      short_id: child.short_id,
      qualified_id: child.qualified_id,
      status: child.status,
      title: child.title,
    }),
  );
  const comments = (show.comments ?? []).slice(-MAX_COMMENTS).map((c) => ({
    uid: c.uid,
    author: c.author,
    body: c.body,
    created_at: c.created_at,
  }));
  const labels = (show.labels ?? []).map((l) => l.label);
  // bb's RPC boundary rejects `undefined`, so optional keys are omitted.
  const issue: KataIssueDetail["issue"] = {
    ...raw,
    qualified_id: raw.qualified_id ?? `${projectName}#${raw.short_id}`,
    labels,
    blocks,
    blocked_by: blockedBy,
    related,
  };
  if (parent !== undefined) issue.parent = parent;
  if (blockedBy.some((peer) => peer.status === "open")) issue.blocked = true;
  return { issue, children, comments };
}
