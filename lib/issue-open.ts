// Opening one issue from anywhere in bb (a message chip, the selection
// action, the palette): in a thread, the "Kata issues" side panel with
// `params: { issueUid, projectUid, qualifiedId }`; elsewhere (or when the
// host declines), the Kata nav page with that issue selected.
//
// Palette commands and message actions run outside React, so an always-
// mounted overlay (app.tsx) lends them the app's navigator and RPC client
// through `bridge`.
import type { BbNavigate, PluginRpcClient, PluginTargetedPanelActionOpenOptions } from "@get-bb/plugin-sdk/app";
import type { IssueSummary, KataRpcContract } from "./rpc-contract";
import type { IssueTarget } from "./refs";
import { patch, requestNavIssue, requestPanelFocus, requestScopedFocus } from "./viewer-store";

export const PANEL_PATH = "kata";
export const ISSUES_ACTION_ID = "issues";

export const bridge: {
  navigate: BbNavigate | null;
  rpc: PluginRpcClient<KataRpcContract> | null;
} = { navigate: null, rpc: null };

export const targetOf = (issue: IssueSummary): IssueTarget => ({
  issueUid: issue.uid,
  projectUid: issue.projectUid,
  qualifiedId: issue.qualifiedId,
});

export function panelOptions(target: IssueTarget): PluginTargetedPanelActionOpenOptions {
  return {
    actionId: ISSUES_ACTION_ID,
    title: `Kata · ${target.qualifiedId ?? "issue"}`,
    params: { issueUid: target.issueUid, projectUid: target.projectUid, qualifiedId: target.qualifiedId },
  };
}

/** Where the issue opened. */
export function openIssue(
  target: IssueTarget,
  via: { openPanel?: ((options: PluginTargetedPanelActionOpenOptions) => boolean) | null; navigate?: BbNavigate | null },
): "panel" | "nav" | "none" {
  if (via.openPanel) {
    // Opened on purpose: the panel takes keyboard focus when it mounts (or is already open).
    requestScopedFocus();
    if (via.openPanel(panelOptions(target))) return "panel";
    patch({ scopedFocus: null });
  }
  const navigate = via.navigate ?? bridge.navigate;
  if (!navigate) return "none";
  requestNavIssue(target);
  navigate.toPluginPanel(PANEL_PATH);
  requestPanelFocus();
  return "nav";
}

// ---- palette dialogs (rendered by components/command-dialogs.tsx) ---------------------

export type CommandDialog =
  | {
      kind: "open";
      threadId: string | null;
      projectId: string | null;
      openPanel: ((options: PluginTargetedPanelActionOpenOptions) => boolean) | null;
    }
  | { kind: "link"; threadId: string };

let dialog: CommandDialog | null = null;
const listeners = new Set<() => void>();

export const commandDialogStore = {
  get: () => dialog,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  set(next: CommandDialog | null) {
    dialog = next;
    listeners.forEach((listener) => listener());
  },
};
