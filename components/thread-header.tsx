// Management dialog opened by the Kata header action: linked issue details,
// issue panel navigation, linking, and unlinking.
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  experimental_Icon as HostIcon,
  useBbNavigate,
  useRpc,
  type ExperimentalOpenTabOptions,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { KataIssue } from "@/lib/kata-types";
import type { KataRpcContract } from "@/lib/rpc-contract";
import { useThreadBinding } from "@/hooks/useThreadBinding";
import { cn } from "@/lib/utils";

import { PriorityChip, StatusGlyph } from "@/components/issue-bits";

export { ISSUES_ACTION_ID } from "@/lib/issue-open";
import { ISSUES_TAB, openIssue } from "@/lib/issue-open";
import { requestScopedOpen } from "@/lib/viewer-store";
const MAX_MATCHES = 8;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function KataIcon({ className }: { className?: string }) {
  return <HostIcon name="ListTodo" fallback="ListView" className={className ?? "size-3.5"} aria-hidden />;
}

/** Open issues matching `query` by short id, qualified id or title words. */
export function matchIssues(issues: readonly KataIssue[], query: string): KataIssue[] {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const open = issues.filter((issue) => issue.status === "open");
  if (words.length === 0) return open.slice(0, MAX_MATCHES);
  return open
    .filter((issue) => {
      const hay = `${issue.short_id} ${issue.qualified_id} ${issue.title}`.toLowerCase();
      return words.every((word) => hay.includes(word));
    })
    .slice(0, MAX_MATCHES);
}

export function LinkPicker({
  projectUid,
  onPick,
  onCancel,
}: {
  projectUid: string;
  onPick: (issue: KataIssue) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<KataRpcContract>();
  const [issues, setIssues] = useState<KataIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("issues.list", { projectUid, status: "open" }).then(
      (result) => !cancelled && setIssues(result.issues),
      (failure: unknown) => !cancelled && setError(errorText(failure)),
    );
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [rpc, projectUid]);

  const matches = useMemo(() => matchIssues(issues ?? [], query), [issues, query]);
  const current = Math.min(index, Math.max(0, matches.length - 1));

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setIndex((current + 1) % Math.max(1, matches.length));
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setIndex((current - 1 + matches.length) % Math.max(1, matches.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const issue = matches[current];
      if (issue) onPick(issue);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search open issues…"
        aria-label="Search open issues to link"
        className="h-7 rounded border border-border bg-background px-2 text-sm outline-none focus:border-ring"
      />
      <div role="listbox" aria-label="Open issues" className="max-h-64 overflow-y-auto">
        {error ? (
          <p className="px-1 py-2 text-xs text-destructive">{error}</p>
        ) : issues === null ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : matches.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">No open issues match.</p>
        ) : (
          matches.map((issue, i) => (
            <button
              key={issue.uid}
              type="button"
              role="option"
              aria-selected={i === current}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(issue)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm",
                i === current ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
              )}
            >
              <PriorityChip {...(issue.priority === undefined ? {} : { priority: issue.priority })} />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.short_id}</span>
              <span className="min-w-0 flex-1 truncate">{issue.title}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function MenuButton({ onClick, children, disabled }: { onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function KataThreadHeader({ threadId, openTab, onDone }: {
  threadId: string;
  openTab: (options: ExperimentalOpenTabOptions) => boolean;
  onDone: (afterClose?: () => void) => void;
}) {
  const rpc = useRpc<KataRpcContract>();
  const navigate = useBbNavigate();
  const { binding, error, accept } = useThreadBinding(threadId);

  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const project = binding?.kataProject;
  if (!binding) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  if (!project) return <p className="text-sm text-muted-foreground">This thread has no bound Kata project.</p>;
  const link = binding.link;

  // The whole project's issues: the list, with the linked issue selected.
  const openIssues = () => {
    requestScopedOpen(null);
    onDone(() => {
      if (!openTab({ tab: ISSUES_TAB, title: `Kata · ${project.name}` })) {
        toast.error("This view has no thread side panel");
      }
    });
  };

  // The linked issue itself: its detail, like an issue chip.
  const openLinkedIssue = () => {
    if (!link) return;
    onDone(() => {
      const where = openIssue(
        { issueUid: link.issueUid, projectUid: link.projectUid, qualifiedId: link.qualifiedId },
        { openTab, navigate },
      );
      if (where === "none") toast.error("This view has no thread side panel");
    });
  };

  const linkIssue = (issue: KataIssue) => {
    setBusy(true);
    rpc.call("thread.linkIssue", { threadId, projectUid: project.uid, ref: issue.uid }).then(
      (result) => {
        accept(result);
        setPicking(false);
        onDone();
        toast.success(`Linked ${issue.qualified_id}`);
      },
      (error: unknown) => toast.error(`Link failed: ${errorText(error)}`),
    ).finally(() => setBusy(false));
  };

  const unlink = () => {
    setBusy(true);
    rpc.call("thread.unlinkIssue", { threadId }).then(
      (result) => {
        accept(result);
        onDone();
      },
      (error: unknown) => toast.error(`Unlink failed: ${errorText(error)}`),
    ).finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pb-1 pt-0.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <KataIcon className="size-3" />
          <span className="truncate">{project.name}</span>
        </div>
        {link ? (
          <button
            type="button"
            onClick={openLinkedIssue}
            title="open in the Kata panel"
            className="mt-1.5 flex w-full items-start gap-1.5 rounded-md p-1 text-left hover:bg-muted"
          >
            <StatusGlyph status={link.status ?? "open"} className="mt-1" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs">{link.qualifiedId}</span>
                {link.priority != null ? <PriorityChip priority={link.priority} /> : null}
                {link.status && link.status !== "open" ? (
                  <span className="text-xs text-muted-foreground">{link.status}</span>
                ) : null}
              </div>
              <p className="mt-0.5 line-clamp-3 text-sm">{link.title ?? "(issue could not be read)"}</p>
            </div>
          </button>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No issue linked to this thread.</p>
        )}
      </div>
      <div className="h-px bg-border" />
      {picking ? (
        <LinkPicker projectUid={project.uid} onPick={linkIssue} onCancel={() => setPicking(false)} />
      ) : (
        <>
          <MenuButton onClick={openIssues}>Open Kata issues</MenuButton>
          <MenuButton onClick={() => setPicking(true)} disabled={busy}>
            {link ? "Link a different issue…" : "Link issue…"}
          </MenuButton>
          {link ? (
            <MenuButton onClick={unlink} disabled={busy}>
              Unlink
            </MenuButton>
          ) : null}
        </>
      )}
    </div>
  );
}
