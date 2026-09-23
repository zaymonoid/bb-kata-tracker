// The left pane: one row per issue, like `kata tui`'s list. Rows come from
// lib/tree.ts (nested with box-drawing guides, or flat). Selection is owned
// by the panel; this renders it and scrolls it into view. The panel slots in
// the new-issue draft row and the inline title editor.
import { forwardRef, memo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { KataIssue } from "@/lib/kata-types";
import type { TreeRow } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { LabelChip, PriorityChip, StatusGlyph } from "@/components/issue-bits";

export const ROW_HEIGHT = 32;
const MAX_LABELS = 3;

const IssueRow = memo(function IssueRow({
  row,
  selected,
  focused,
  pending,
  linked,
  editor,
  onSelect,
  onToggle,
}: {
  row: TreeRow;
  selected: boolean;
  /** The list has the keyboard: the selected row is shown in full. */
  focused: boolean;
  /** Linked to the thread this panel sits in. */
  linked: boolean;
  /** Placeholder of a create still in flight. */
  pending: boolean;
  editor: ReactNode;
  onSelect: (uid: string) => void;
  onToggle: (uid: string) => void;
}) {
  const { issue } = row;
  const labels = issue.labels ?? [];
  const closed = issue.status === "closed";
  return (
    <div
      role="option"
      aria-selected={selected}
      data-issue-uid={issue.uid}
      onMouseDown={(event) => {
        if (editor) return;
        // Keep focus on the list container rather than the row.
        event.preventDefault();
        onSelect(issue.uid);
      }}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        // mx-1 + px-2 keeps the old px-3 text position while the selection and
        // hover background stay clear of the pane border.
        "mx-1 flex cursor-default items-center gap-2 rounded-md px-2 text-sm",
        selected
          ? focused
            ? "bg-accent text-accent-foreground"
            : "bg-accent/40"
          : "hover:bg-muted/60",
        !row.match && "opacity-60",
      )}
    >
      {row.guide ? (
        <span aria-hidden className="shrink-0 whitespace-pre font-mono text-xs text-muted-foreground/70">
          {row.guide}
        </span>
      ) : null}
      {row.childCount > 0 ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={row.expanded ? "Collapse" : "Expand"}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle(issue.uid);
          }}
          className="-mx-0.5 w-3 shrink-0 text-center font-mono text-[10px] text-muted-foreground hover:text-foreground"
        >
          {row.expanded ? "▾" : "▸"}
        </button>
      ) : null}
      <StatusGlyph status={issue.status} blocked={issue.blocked} />
      <PriorityChip priority={issue.priority} />
      <span
        className={cn(
          "w-10 shrink-0 font-mono text-xs text-muted-foreground",
          pending && "animate-pulse",
        )}
      >
        {issue.short_id}
      </span>
      {editor ?? (
        <span className={cn("min-w-0 flex-1 truncate", closed && "text-muted-foreground line-through")}>
          {issue.title}
        </span>
      )}
      {!row.expanded && row.childCount > 0 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">+{row.childCount}</span>
      ) : null}
      {closed && issue.closed_reason ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{issue.closed_reason}</span>
      ) : null}
      {labels.slice(0, MAX_LABELS).map((label) => (
        <LabelChip key={label} label={label} />
      ))}
      {labels.length > MAX_LABELS ? (
        <span className="text-[10px] text-muted-foreground">+{labels.length - MAX_LABELS}</span>
      ) : null}
      {linked ? (
        <span title="Linked to this thread" className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
          linked
        </span>
      ) : null}
      {issue.owner ? (
        <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
          @{issue.owner}
        </span>
      ) : null}
    </div>
  );
});

export interface IssueListProps {
  rows: readonly TreeRow[];
  selectedUid: string | null;
  focused: boolean;
  /** Draft row and where it goes: after that uid's row, or on top (null). */
  draft: { node: ReactNode; afterUid: string | null } | null;
  /** Inline title editor for one row. */
  editing: { uid: string; node: ReactNode } | null;
  isPending: (issue: KataIssue) => boolean;
  /** Issue linked to the host thread, marked in its row. */
  linkedUid?: string | null;
  onSelect: (uid: string) => void;
  onToggle: (uid: string) => void;
  onFocus: () => void;
  empty: ReactNode;
}

export const IssueList = forwardRef<HTMLDivElement, IssueListProps>(function IssueList(
  { rows, selectedUid, focused, draft, editing, isPending, linkedUid, onSelect, onToggle, onFocus, empty },
  ref,
) {
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selectedUid === null) return;
    const row = scroller.current?.querySelector<HTMLElement>(
      `[data-issue-uid="${CSS.escape(selectedUid)}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedUid, rows]);

  useEffect(() => {
    if (draft) scroller.current?.querySelector<HTMLElement>("[data-draft-row]")?.scrollIntoView({ block: "nearest" });
  }, [draft?.afterUid, draft !== null]);

  const draftOnTop = draft !== null && (draft.afterUid === null || !rows.some((r) => r.issue.uid === draft.afterUid));

  return (
    <div
      ref={(node) => {
        scroller.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      role="listbox"
      aria-label="Issues"
      tabIndex={0}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
      // py-1 keeps the first and last row's inset highlight off the edges. No
      // focus ring: it would draw a second line along every pane boundary; the
      // selected row's colour says whether the list has the keyboard.
      className="h-full min-h-0 overflow-y-auto py-1 outline-none"
    >
      {draftOnTop ? draft.node : null}
      {rows.length === 0 && draft === null ? empty : null}
      {rows.map((row) => (
        <div key={row.issue.uid} className="contents">
          <IssueRow
            row={row}
            selected={row.issue.uid === selectedUid}
            focused={focused}
            pending={isPending(row.issue)}
            linked={row.issue.uid === linkedUid}
            editor={editing?.uid === row.issue.uid ? editing.node : null}
            onSelect={onSelect}
            onToggle={onToggle}
          />
          {!draftOnTop && draft?.afterUid === row.issue.uid ? draft.node : null}
        </div>
      ))}
    </div>
  );
});
