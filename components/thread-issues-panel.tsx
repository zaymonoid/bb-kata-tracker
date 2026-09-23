// The "Kata issues" thread panel: the Kata panel pinned to the thread's
// kata-bound project (no tabs), preselecting the thread's linked issue, with
// `L` linking the selection to the thread. Opened with `params:
// { issueUid, projectUid, qualifiedId }` (an issue chip, the selection action,
// the palette) it shows that issue's project, which may differ from the
// binding, with the issue selected. Params are untrusted (lib/refs.ts).
import { useCallback, useMemo } from "react";
import { useRpc, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { KataIssue } from "@/lib/kata-types";
import type { KataRpcContract } from "@/lib/rpc-contract";
import { readIssueTarget } from "@/lib/refs";
import { useThreadBinding } from "@/hooks/useThreadBinding";
import { EmptyState } from "@/components/issue-bits";
import { KataPanel, type KataPanelScope } from "@/components/kata-panel";

export function ThreadIssuesPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<KataRpcContract>();
  const { binding, error, accept } = useThreadBinding(threadId);
  const target = useMemo(() => readIssueTarget(params), [params]);
  const projectUid = target?.projectUid ?? binding?.kataProject?.uid ?? null;
  const link = binding?.link ?? null;
  const linkedIssueUid = link && link.projectUid === projectUid ? link.issueUid : null;

  const onLink = useCallback(
    (issue: KataIssue) => {
      if (projectUid === null) return;
      rpc.call("thread.linkIssue", { threadId, projectUid, ref: issue.uid }).then(
        (result) => {
          accept(result);
          toast.success(`Linked ${issue.qualified_id} to this thread`);
        },
        (failure: unknown) =>
          toast.error(`Link failed: ${failure instanceof Error ? failure.message : String(failure)}`),
      );
    },
    [rpc, threadId, projectUid, accept],
  );

  const scope = useMemo<KataPanelScope | null>(
    () => (projectUid === null ? null : { projectUid, linkedIssueUid, onLink, target }),
    [projectUid, linkedIssueUid, onLink, target],
  );

  if (scope === null) {
    return (
      <div className="flex h-full flex-col">
        {binding === null ? (
          <EmptyState>{error ? `Could not read the kata binding: ${error}` : "Loading…"}</EmptyState>
        ) : (
          <EmptyState>
            <p>This thread's project is not bound to a kata project.</p>
            <p className="mt-2 text-xs">
              {binding.reason ?? "Add a .kata.toml"} · run <code>kata init</code> in the project directory.
            </p>
          </EmptyState>
        )}
      </div>
    );
  }
  return <KataPanel scope={scope} />;
}
