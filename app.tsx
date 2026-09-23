// bb-plugin-kata — frontend entry.
//
// A "Kata" sidebar page mirroring `kata tui`: one tab per included kata
// project, issue list on the left, detail on the right, keyboard-first
// (components/kata-panel.tsx, lib/keymap.ts). Data comes from server.ts over
// RPC and stays warm through realtime `issues.changed` signals.
//
// Kata-aware threads: a thread header control (components/thread-header.tsx)
// and a "Kata issues" thread panel pinned to the thread's bound project
// (components/thread-issues-panel.tsx).
//
// Issue links (T5): the `::kata-issue{ref=…}` message directive
// (components/issue-chip.tsx), a message action opening a ref found in the
// selection, and palette commands. The SDK has no hook to decorate plain text
// in assistant messages, so bare `project#abc4` mentions are reached through
// the directive and the action.
import { useEffect } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { KataPanel } from "@/components/kata-panel";
import { KataThreadHeader } from "@/components/thread-header";
import { ThreadIssuesPanel } from "@/components/thread-issues-panel";
import { IssueChipDirective } from "@/components/issue-chip";
import { CommandDialogs } from "@/components/command-dialogs";
import { bridge, commandDialogStore, ISSUES_ACTION_ID, openIssue, PANEL_PATH, targetOf } from "@/lib/issue-open";
import { extractRefs } from "@/lib/refs";
import type { KataRpcContract } from "@/lib/rpc-contract";
import { requestPanelFocus } from "@/lib/viewer-store";

// Palette commands and message actions run outside React: an always-mounted,
// invisible overlay lends them the app's navigator and RPC client.
function Bridge() {
  const nav = useBbNavigate();
  const rpc = useRpc<KataRpcContract>();
  useEffect(() => {
    bridge.navigate = nav;
    bridge.rpc = rpc;
    return () => {
      if (bridge.navigate === nav) bridge.navigate = null;
      if (bridge.rpc === rpc) bridge.rpc = null;
    };
  }, [nav, rpc]);
  return null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "kata",
    title: "Kata",
    icon: "ListTodo",
    path: PANEL_PATH,
    component: () => <KataPanel />,
  });

  app.slots.experimental_threadHeaderAction({
    id: "kata",
    title: "Kata",
    component: KataThreadHeader,
  });

  app.slots.threadPanelAction({
    id: ISSUES_ACTION_ID,
    title: "Kata issues",
    icon: "ListTodo",
    layout: "flush",
    component: ThreadIssuesPanel,
  });

  app.slots.messageDirective({ id: "kata-issue", component: IssueChipDirective });

  app.slots.messageAction({
    id: "open-issue",
    title: "Kata: open issue from selection",
    icon: "ListTodo",
    run: async ({ threadId, message, selectedText, openPanel }) => {
      // From the action bar (no selection) the whole message is searched.
      const source = selectedText ?? message.text;
      const where = selectedText !== undefined ? "selection" : "message";
      const refs = extractRefs(source);
      if (refs.length === 0) return void toast(`No kata ref in ${where}`);
      if (!bridge.rpc) return void toast.error("Kata is still loading");
      try {
        const { issue, reason } = await bridge.rpc.call("issues.resolve", { refs, threadId });
        if (issue === null) {
          // Name the failure only for refs that were unmistakably meant as refs.
          const explicit = refs.find((ref) => ref.includes("#") || ref.length === 26);
          return void toast(`No kata ref in ${where}${explicit ? ` (${explicit}: ${reason ?? "not found"})` : ""}`);
        }
        openIssue(targetOf(issue), { openPanel });
      } catch (error) {
        toast.error(`Kata lookup failed: ${errorText(error)}`);
      }
    },
  });

  app.slots.experimental_appOverlay({ id: "navigator", component: Bridge });
  app.slots.experimental_appOverlay({ id: "command-dialogs", component: CommandDialogs });

  app.commands.register({
    id: "open",
    title: "Kata: open issue viewer",
    defaultShortcut: { key: "k", mod: true, shift: true },
    run: () => {
      bridge.navigate?.toPluginPanel(PANEL_PATH);
      // Focus the list whether the panel was already open or is mounting now.
      requestPanelFocus();
    },
  });

  app.commands.register({
    id: "open-issue",
    title: "Kata: open issue…",
    run: ({ threadId, projectId, openPanel }) => {
      commandDialogStore.set({ kind: "open", threadId, projectId, openPanel: threadId ? openPanel : null });
    },
  });

  app.commands.register({
    id: "link-issue",
    title: "Kata: link issue to this thread",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId) commandDialogStore.set({ kind: "link", threadId });
    },
  });
});
