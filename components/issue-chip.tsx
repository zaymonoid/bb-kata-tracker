// `::kata-issue{ref="grippify#06fh"}` (or `ref="06fh"`, resolved against the
// message's project binding, or `uid="<ULID>"`) in assistant messages: a
// chip with status, priority, `project#abc4` and title. Click opens the
// issue in the thread's Kata panel; right-click offers copying the ref.
// Attributes are untrusted: lib/refs.ts validates them and
// the server resolves the ref before anything is shown.
import { useMemo } from "react";
import { useBbNavigate, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { formatRef, parseIssueDirective } from "@/lib/refs";
import { openIssue, targetOf } from "@/lib/issue-open";
import type { IssueSummary } from "@/lib/rpc-contract";
import { useResolvedIssue } from "@/hooks/useResolvedIssue";
import { cn } from "@/lib/utils";
import { PriorityChip, StatusGlyph } from "@/components/issue-bits";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function MutedRef({ label, title }: { label: string; title: string }) {
  return (
    <span title={title} className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {label}
    </span>
  );
}

export function IssueChipDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const parsed = useMemo(() => parseIssueDirective(attributes), [attributes]);
  const input = parsed.ok
    ? {
        refs: [formatRef(parsed.ref)],
        ...(message.projectId ? { projectId: message.projectId } : { threadId: message.threadId }),
      }
    : null;
  const resolved = useResolvedIssue(input);
  if (!parsed.ok) return <MutedRef label={parsed.label} title={`kata: ${parsed.reason}`} />;
  if (resolved.state === "loading") return <MutedRef label={parsed.label} title="Looking up kata issue…" />;
  if (resolved.state === "missing") return <MutedRef label={parsed.label} title={resolved.reason === "not found" ? "not found" : `not found: ${resolved.reason}`} />;
  return <IssueChip issue={resolved.issue} />;
}

export function IssueChip({ issue }: { issue: IssueSummary }) {
  const navigate = useBbNavigate();
  const closed = issue.status !== "open";

  const open = () => {
    const where = openIssue(targetOf(issue), { openPanel: (options) => navigate.openThreadPanel(options), navigate });
    if (where === "none") toast.error("Could not open the Kata panel here");
  };
  const copy = () => {
    navigator.clipboard.writeText(issue.qualifiedId).then(
      () => toast.success(`Copied ${issue.qualifiedId}`),
      (error: unknown) => toast.error(`Could not copy: ${errorText(error)}`),
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={open}
          title={`${issue.qualifiedId} · ${issue.title}\nClick: open in Kata panel · right-click: more`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-left align-middle text-sm hover:bg-muted"
        >
          <StatusGlyph status={issue.status} blocked={issue.blocked} />
          {issue.priority !== null ? <PriorityChip priority={issue.priority} /> : null}
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.qualifiedId}</span>
          <span className={cn("min-w-0 truncate", closed && "text-muted-foreground line-through")}>{issue.title}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={open}>Open in Kata panel</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={copy}>Copy ref</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
