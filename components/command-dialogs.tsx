// Dialogs behind two palette commands (lib/issue-open.ts `commandDialogStore`):
// "Kata: open issue…" asks for a ref and opens it (thread panel in a
// thread, else the nav page); "Kata: link issue to this thread" reuses the
// thread header's typeahead. Mounted once as an app overlay.
import { useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { commandDialogStore, openIssue, targetOf, type CommandDialog } from "@/lib/issue-open";
import type { KataIssue } from "@/lib/kata-types";
import type { KataRpcContract } from "@/lib/rpc-contract";
import { REF_HINT, tryParseRef } from "@/lib/refs";
import { useThreadBinding } from "@/hooks/useThreadBinding";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LinkPicker } from "@/components/thread-header";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function OpenIssueForm({ dialog, onDone }: { dialog: Extract<CommandDialog, { kind: "open" }>; onDone: () => void }) {
  const rpc = useRpc<KataRpcContract>();
  const navigate = useBbNavigate();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    const parsed = tryParseRef(text);
    if (parsed === null) return setError(REF_HINT.replace(/`/gu, ""));
    setBusy(true);
    setError(null);
    rpc
      .call("issues.resolve", {
        refs: [text.trim()],
        ...(dialog.threadId ? { threadId: dialog.threadId } : dialog.projectId ? { projectId: dialog.projectId } : {}),
      })
      .then(
        ({ issue, reason }) => {
          if (issue === null) return setError(reason ?? "not found");
          onDone();
          openIssue(targetOf(issue), { openPanel: dialog.openPanel, navigate });
        },
        (failure: unknown) => setError(errorText(failure)),
      )
      .finally(() => setBusy(false));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        autoFocus
        value={text}
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        placeholder={dialog.threadId ? "abc4 or project#abc4" : "project#abc4"}
        aria-label="Kata issue ref"
        className="h-8 rounded border border-border bg-background px-2 font-mono text-sm outline-none focus:border-ring"
      />
      <p className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role={error ? "alert" : undefined}>
        {error ?? (busy ? "Looking up…" : "enter to open it · a bare id uses this thread's kata project")}
      </p>
    </div>
  );
}

function LinkIssueForm({ threadId, onDone }: { threadId: string; onDone: () => void }) {
  const rpc = useRpc<KataRpcContract>();
  const { binding, error } = useThreadBinding(threadId);
  const project = binding?.kataProject ?? null;
  if (binding === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  if (project === null) {
    return <p className="text-sm text-muted-foreground">This thread's project is not bound to a kata project ({binding.reason ?? "no .kata.toml"}).</p>;
  }
  const pick = (issue: KataIssue) => {
    rpc.call("thread.linkIssue", { threadId, projectUid: project.uid, ref: issue.uid }).then(
      () => {
        onDone();
        toast.success(`Linked ${issue.qualified_id} to this thread`);
      },
      (failure: unknown) => toast.error(`Link failed: ${errorText(failure)}`),
    );
  };
  return <LinkPicker projectUid={project.uid} onPick={pick} onCancel={onDone} />;
}

export function CommandDialogs() {
  const dialog = useSyncExternalStore(commandDialogStore.subscribe, commandDialogStore.get);
  const close = () => commandDialogStore.set(null);
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{dialog?.kind === "link" ? "Link a kata issue to this thread" : "Open kata issue"}</DialogTitle>
          <DialogDescription>
            {dialog?.kind === "link" ? "Search the thread's kata project." : "Type a ref: abc4, project#abc4, or an issue ULID."}
          </DialogDescription>
        </DialogHeader>
        {dialog?.kind === "open" ? <OpenIssueForm dialog={dialog} onDone={close} /> : null}
        {dialog?.kind === "link" ? <LinkIssueForm threadId={dialog.threadId} onDone={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}
