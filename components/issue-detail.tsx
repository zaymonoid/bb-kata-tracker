// The right pane: a document-style view of one issue. It renders the list's
// copy of the issue immediately and fills in comments and children when
// `issues.get` answers.
import { forwardRef } from "react";
import type { ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { KataComment, KataIssue, KataIssueDetail, KataLinkPeer } from "@/lib/kata-types";
import { cn } from "@/lib/utils";
import { LabelChip, PriorityChip, StatusGlyph } from "@/components/issue-bits";

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function PeerList({
  peers,
  titleOf,
  onOpen,
}: {
  peers: readonly KataLinkPeer[];
  titleOf: (peer: KataLinkPeer) => string | undefined;
  onOpen: (peer: KataLinkPeer) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {peers.map((peer) => (
        <li key={peer.uid}>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onOpen(peer)}
            className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted/60"
          >
            <StatusGlyph status={peer.status} />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {peer.qualified_id}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                peer.status === "closed" && "text-muted-foreground line-through",
              )}
            >
              {titleOf(peer) ?? ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface IssueDetailProps {
  issue: KataIssue | null;
  detail: KataIssueDetail | null;
  detailError: string | null;
  /** Optimistic comments still being posted. */
  pendingComments: readonly KataComment[];
  focused: boolean;
  onFocus: () => void;
  titleOf: (peer: KataLinkPeer) => string | undefined;
  onOpenPeer: (peer: KataLinkPeer) => void;
}

export const IssueDetail = forwardRef<HTMLDivElement, IssueDetailProps>(function IssueDetail(
  { issue: listIssue, detail, detailError, pendingComments, focused, onFocus, titleOf, onOpenPeer },
  ref,
) {
  // Prefer the list copy for fields both have (it is refreshed by events) and
  // the detail for what only it has.
  const issue =
    listIssue && detail && detail.issue.uid === listIssue.uid
      ? { ...detail.issue, ...listIssue }
      : (listIssue ?? detail?.issue ?? null);
  const current = detail && issue && detail.issue.uid === issue.uid ? detail : null;
  const comments = [...(current?.comments ?? []), ...pendingComments];

  return (
    <div
      ref={ref}
      tabIndex={0}
      onFocus={onFocus}
      aria-label="Issue detail"
      className={cn(
        "h-full min-h-0 overflow-y-auto outline-none",
        focused && "ring-1 ring-inset ring-ring/40",
      )}
    >
      {issue === null ? (
        <p className="p-6 text-sm text-muted-foreground">No issue selected.</p>
      ) : (
        <article className="mx-auto max-w-3xl px-5 py-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusGlyph status={issue.status} blocked={issue.blocked} />
            <span className="font-mono">{issue.qualified_id}</span>
            <span>·</span>
            <span>{issue.status}</span>
            {issue.closed_reason ? <span>({issue.closed_reason})</span> : null}
            <PriorityChip priority={issue.priority} />
            {issue.owner ? <span>owner @{issue.owner}</span> : <span>unowned</span>}
          </div>
          <h2 className="mt-2 text-lg font-semibold leading-snug text-foreground">
            {issue.title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            by {issue.author} · created {formatDate(issue.created_at)} · updated{" "}
            {formatDate(issue.updated_at)}
          </p>
          {(issue.labels ?? []).length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {(issue.labels ?? []).map((label) => (
                <LabelChip key={label} label={label} />
              ))}
            </div>
          ) : null}

          <div className="mt-4 text-sm">
            {issue.body.trim() === "" ? (
              <p className="italic text-muted-foreground">No description.</p>
            ) : (
              <Markdown content={issue.body} />
            )}
          </div>

          {issue.parent ? (
            <Section title="Parent">
              <PeerList peers={[issue.parent]} titleOf={titleOf} onOpen={onOpenPeer} />
            </Section>
          ) : null}
          {current && current.children.length > 0 ? (
            <Section title={`Children (${current.children.length})`}>
              <PeerList peers={current.children} titleOf={titleOf} onOpen={onOpenPeer} />
            </Section>
          ) : issue.child_counts && issue.child_counts.total > 0 ? (
            <Section title="Children">
              <p className="text-sm text-muted-foreground">
                {issue.child_counts.open} open of {issue.child_counts.total}
              </p>
            </Section>
          ) : null}
          {(issue.blocked_by ?? []).length > 0 ? (
            <Section title="Blocked by">
              <PeerList peers={issue.blocked_by ?? []} titleOf={titleOf} onOpen={onOpenPeer} />
            </Section>
          ) : null}
          {(issue.blocks ?? []).length > 0 ? (
            <Section title="Blocks">
              <PeerList peers={issue.blocks ?? []} titleOf={titleOf} onOpen={onOpenPeer} />
            </Section>
          ) : null}
          {(issue.related ?? []).length > 0 ? (
            <Section title="Related">
              <PeerList peers={issue.related ?? []} titleOf={titleOf} onOpen={onOpenPeer} />
            </Section>
          ) : null}

          {comments.length > 0 ? (
            <Section title={`Comments (${comments.length})`}>
              <ol className="space-y-3">
                {comments.map((comment) => (
                  <li
                    key={comment.uid}
                    className={cn(
                      "rounded-md border border-border p-3",
                      comment.created_at === "" && "opacity-60",
                    )}
                  >
                    <p className="mb-1 text-xs text-muted-foreground">
                      {comment.author}
                      {comment.created_at ? ` · ${formatDate(comment.created_at)}` : ""}
                    </p>
                    <div className="text-sm">
                      <Markdown content={comment.body} />
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}
          {detailError ? (
            <p role="alert" className="mt-4 text-xs text-destructive">
              Could not load comments: {detailError}
            </p>
          ) : null}
        </article>
      )}
    </div>
  );
});
