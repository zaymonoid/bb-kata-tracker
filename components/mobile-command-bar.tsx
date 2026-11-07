import { useRef, useState } from "react";
import type { KataIssue } from "@/lib/kata-types";
import type { KeyCommand } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

/** Thumb-reachable primary actions; secondary actions belong to the issue sheet. */
export function MobileCommandBar({ issue, editable, scoped, statusView, onCommand }: {
  issue: KataIssue | null;
  editable: boolean;
  scoped: boolean;
  statusView: "open" | "closed" | "all";
  onCommand: (command: KeyCommand) => void;
}) {
  const [sheet, setSheet] = useState<"priority" | "more" | null>(null);
  const expanded = sheet !== null;
  const setExpanded = (open: boolean) => setSheet(open ? "more" : null);
  const pending = useRef<KeyCommand | null>(null);
  // Open editors after the sheet has returned focus, so it cannot steal the keyboard.
  const runFromSheet = (command: KeyCommand) => {
    pending.current = command;
    setExpanded(false);
  };
  const row = (label: string, icon: "Edit" | "ListTodo" | "Copy" | "MessageSquarePlus", command: KeyCommand, disabled = false) => (
    <button type="button" className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted disabled:opacity-40" disabled={disabled} onClick={() => runFromSheet(command)}>
      <Icon name={icon} className="size-4 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      <Icon name="ChevronRight" className="size-4 text-muted-foreground/50" />
    </button>
  );
  return (
    <div className="shrink-0 border-t border-border/60 bg-background px-3 py-2" role="group" aria-label={issue ? `Commands for ${issue.short_id}` : "Issue list commands"} onKeyDown={(event) => event.stopPropagation()}>
      <div className={cn("items-center gap-2", issue ? "grid grid-cols-4" : "flex")}>
        {issue ? <>
          <Button type="button" variant="ghost" className="h-14 min-w-0 flex-1 flex-col gap-1 rounded-xl px-1 text-xs" disabled={!editable} aria-label={`Change priority (${issue.priority === null ? "none" : `P${issue.priority}`})`} aria-haspopup="dialog" aria-expanded={sheet === "priority"} onClick={() => setSheet("priority")}>
            <span className="flex h-5 items-center font-mono text-sm font-semibold">{issue.priority === null ? "–" : `P${issue.priority}`}</span>
            Priority
          </Button>
          <Button type="button" variant="ghost" className="h-14 min-w-0 flex-1 flex-col gap-1 rounded-xl px-1 text-xs" disabled={!editable} onClick={() => onCommand({ type: issue.status === "closed" ? "reopen" : "close" })}>
            <span className="flex h-5 items-center"><Icon name={issue.status === "closed" ? "Circle" : "CircleCheck"} /></span> {issue.status === "closed" ? "Reopen" : "Close"}
          </Button>
          <Button type="button" variant="secondary" className="h-14 min-w-0 flex-1 flex-col gap-1 rounded-xl px-1 text-xs" onClick={() => onCommand({ type: "newThread" })}>
            <span className="flex h-5 items-center"><Icon name="MessageSquarePlus" /></span> Start thread
          </Button>
          <Button type="button" variant="ghost" className="h-14 min-w-0 flex-col gap-1 rounded-xl px-1 text-xs" aria-label="More issue actions" aria-haspopup="dialog" aria-expanded={sheet === "more"} onClick={() => setSheet("more")}><span className="flex h-5 items-center"><Icon name="MoreHorizontal" /></span>More</Button>
        </> : <>
          <Button type="button" variant="ghost" className="h-11 rounded-xl px-3 capitalize" aria-label={`Showing ${statusView} issues; change status filter`} onClick={() => onCommand({ type: "cycleStatus" })}><Icon name="ListTodo" />{statusView}</Button>
          <Button type="button" variant="ghost" className="size-11 rounded-xl p-0" aria-label="Filter issues" onClick={() => onCommand({ type: "search" })}><Icon name="Search" /></Button>
          <Button type="button" className="ml-auto h-11 rounded-xl px-5" disabled={!editable} onClick={() => onCommand({ type: "newIssue" })}><span aria-hidden className="text-lg leading-none">+</span> New issue</Button>
        </>}
      </div>
      {issue ? (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent className="gap-5" onKeyDown={(event) => event.stopPropagation()} onAfterCloseAutoFocus={() => {
            const command = pending.current;
            pending.current = null;
            if (command) onCommand(command);
          }}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <DialogDescription className="mb-1 font-mono text-xs">{issue.short_id} · {issue.status}</DialogDescription>
                <DialogTitle className="text-lg leading-snug">{sheet === "priority" ? "Set priority" : issue.title}</DialogTitle>
              </div>
              <Button type="button" variant="ghost" className="size-11 shrink-0 rounded-full p-0" aria-label="Dismiss issue actions" onClick={() => setExpanded(false)}><Icon name="X" /></Button>
            </div>
            {sheet === "priority" ? <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Priority</p>
              <div className="flex gap-1 rounded-xl bg-muted/50 p-1" role="group" aria-label="Priority">
                {[null, 0, 1, 2, 3, 4].map((priority) => (
                  <Button key={priority ?? "none"} type="button" variant={issue.priority === priority ? "secondary" : "ghost"} className="h-11 min-w-0 flex-1 rounded-lg px-1 text-xs" aria-label={priority === null ? "No priority" : `Priority ${priority}`} aria-pressed={issue.priority === priority} disabled={!editable} onClick={() => runFromSheet({ type: "setPriority", priority })}>
                    {priority === null ? "None" : `P${priority}`}
                  </Button>
                ))}
              </div>
            </div> : null}
            {sheet === "more" ? <>
            <div className="rounded-xl border border-border/60 p-1">
              {row("Rename issue", "Edit", { type: "editTitle" }, !editable)}
              {row("Edit description", "Edit", { type: "editBody" }, !editable)}
              {row("Manage labels", "ListTodo", { type: "label" }, !editable)}
              {row("Add sub-issue", "ListTodo", { type: "newChild" }, !editable || issue.status === "closed")}
            </div>
            <div className="rounded-xl border border-border/60 p-1">
              {row("Add comment", "MessageSquarePlus", { type: "comment" }, !editable)}
              {scoped ? row("Link to this thread", "MessageSquarePlus", { type: "linkThread" }, !editable) : null}
              {row("Copy issue reference", "Copy", { type: "copyRef" })}
            </div>
            </> : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
