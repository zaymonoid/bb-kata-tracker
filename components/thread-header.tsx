// The thread header control for kata-bound threads: one 28px button showing
// the bound kata project, or the linked issue (`project#abc4` + priority).
// Its popover shows the linked issue and offers the panel, linking (with a
// typeahead over the project's open issues) and unlinking.
// Renders nothing when the thread's project is not kata-bound.
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  experimental_Icon as HostIcon,
  useBbNavigate,
  useRpc,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { KataIssue } from "@/lib/kata-types";
import type { KataRpcContract } from "@/lib/rpc-contract";
import { useThreadBinding } from "@/hooks/useThreadBinding";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PriorityChip, StatusGlyph } from "@/components/issue-bits";

export { ISSUES_ACTION_ID } from "@/lib/issue-open";
import { ISSUES_ACTION_ID } from "@/lib/issue-open";
import { requestScopedFocus } from "@/lib/viewer-store";
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

export function KataThreadHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<KataRpcContract>();
  const navigate = useBbNavigate();
  const { binding, accept } = useThreadBinding(threadId);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Set while opening the panel, so closing the popover leaves focus to it. */
  const openingPanel = useRef(false);

  useEffect(() => {
    if (!open) setPicking(false);
  }, [open]);

  const project = binding?.kataProject;
  if (!binding || !project) return null;
  const link = binding.link;

  const openPanel = () => {
    openingPanel.current = true;
    requestScopedFocus();
    setOpen(false);
    if (!navigate.openThreadPanel({ actionId: ISSUES_ACTION_ID, title: `Kata · ${project.name}` })) {
      openingPanel.current = false;
      toast.error("This view has no thread side panel");
    }
  };

  const linkIssue = (issue: KataIssue) => {
    setBusy(true);
    rpc.call("thread.linkIssue", { threadId, projectUid: project.uid, ref: issue.uid }).then(
      (result) => {
        accept(result);
        setPicking(false);
        setOpen(false);
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
        setOpen(false);
      },
      (error: unknown) => toast.error(`Unlink failed: ${errorText(error)}`),
    ).finally(() => setBusy(false));
  };

  const label = link ? link.qualifiedId : project.name;
  const accessibleName = link
    ? `Kata: linked to ${link.qualifiedId}${link.title ? ` ${link.title}` : ""}`
    : `Kata project ${project.name}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={accessibleName}
          title={link?.title ? `${link.qualifiedId} · ${link.title}` : accessibleName}
          className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <KataIcon />
          {isCompactViewport ? null : (
            <>
              <span className={cn("truncate", link && "font-mono")}>{label}</span>
              {link?.priority != null ? <PriorityChip priority={link.priority} /> : null}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-2"
        mobileTitle="Kata"
        onCloseAutoFocus={(event) => {
          if (!openingPanel.current) return;
          openingPanel.current = false;
          event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-1">
          <div className="px-2 pb-1 pt-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <KataIcon className="size-3" />
              <span className="truncate">{project.name}</span>
            </div>
            {link ? (
              <div className="mt-1.5 flex items-start gap-1.5">
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
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">No issue linked to this thread.</p>
            )}
          </div>
          <div className="h-px bg-border" />
          {picking ? (
            <LinkPicker projectUid={project.uid} onPick={linkIssue} onCancel={() => setPicking(false)} />
          ) : (
            <>
              <MenuButton onClick={openPanel}>Open Kata issues</MenuButton>
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
      </PopoverContent>
    </Popover>
  );
}
