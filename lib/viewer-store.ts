// Frontend state for the Kata panel, kept at module level so every included
// project's list stays cached across tab switches and panel remounts:
// switching tabs never waits on the network. Realtime signals refetch only
// the project that changed.
//
// Mutations are optimistic (lib/optimistic.ts): each one patches what the
// list shows at once, then reconciles with the issue its RPC returns; a
// failure drops the patch, which rolls it back. `lists[uid]` is always the
// reconciled view; the raw server lists stay private here.
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { CloseReason } from "./close-rules";
import type { KataRpcContract } from "./rpc-contract";
import type { KataIssue, KataIssueDetail, KataLinkPeer, KataProject } from "./kata-types";
import { reconcile, type Lingering, type PendingEdit, type StatusView } from "./optimistic";
import type { IssueTarget } from "./refs";

export type Rpc = PluginRpcClient<KataRpcContract>;
export type { StatusView } from "./optimistic";

/** `s` cycles a tab's status view in this order. */
export const STATUS_CYCLE: readonly StatusView[] = ["open", "all", "closed"];

export interface ProjectList {
  issues: KataIssue[] | null;
  truncated: boolean;
  error: string | null;
}

export interface ViewerState {
  projects: KataProject[] | null;
  projectsError: string | null;
  /** Included project uids in tab order; null until loaded. */
  included: string[] | null;
  activeUid: string | null;
  /** The shown list per project, in that project's status view. */
  lists: Readonly<Record<string, ProjectList>>;
  /** Status view per project tab (absent = open). */
  status: Readonly<Record<string, StatusView>>;
  /** Open issues per project (the tab counts), whatever view is shown. */
  openCounts: Readonly<Record<string, number>>;
  /** Selected issue uid per project, so each tab keeps its place. */
  selected: Readonly<Record<string, string>>;
  /** Expanded parent uids per project (nested view starts collapsed). */
  expanded: Readonly<Record<string, ReadonlySet<string>>>;
  /** Live filter per project tab. */
  filters: Readonly<Record<string, string>>;
  nested: boolean;
  daemon: { available: boolean; message: string | null };
  /** Bumped to ask the mounted panel to take keyboard focus. */
  focusRequest: number;
  /** A deliberate thread-panel open asks the (next) thread panel to take focus; `at` bounds how long. */
  scopedFocus: { at: number } | null;
  /** Bumped when a cached issue detail changes (after a mutation). */
  detailVersion: number;
  /** An issue the nav page should show (chip, palette); `seq` makes repeats count. */
  navTarget: (IssueTarget & { seq: number }) | null;
  /** A project shown as an extra, unsaved tab because a target lives there. */
  visiting: string | null;
}

type Listener = () => void;

const NO_EXPANDED: ReadonlySet<string> = new Set();

let state: ViewerState = {
  projects: null,
  projectsError: null,
  included: null,
  activeUid: null,
  lists: {},
  status: {},
  openCounts: {},
  selected: {},
  expanded: {},
  filters: {},
  nested: true,
  daemon: { available: true, message: null },
  focusRequest: 0,
  scopedFocus: null,
  detailVersion: 0,
  navTarget: null,
  visiting: null,
};
const listeners = new Set<Listener>();

export const viewerStore = {
  get: (): ViewerState => state,
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function patch(next: Partial<ViewerState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// ---- lists: server copy + optimistic overlay --------------------------------

export const statusOf = (projectUid: string): StatusView => state.status[projectUid] ?? "open";

/** Server lists are cached per project and status view. */
const listKey = (projectUid: string, view: StatusView) => (view === "open" ? projectUid : `${projectUid}:${view}`);
const keyProject = (key: string) => key.split(":")[0]!;

/** What the server last said, per `listKey`. */
const serverLists = new Map<string, ProjectList>();
/** Issues mutation RPCs returned, per project, until the list catches up. */
const confirmed = new Map<string, Map<string, KataIssue>>();
let pending: PendingEdit[] = [];
/** Issues closed from the panel, kept visible per project until the tab is left. */
const lingering = new Map<string, Map<string, Lingering>>();
let nextEditId = 0;

function confirmedFor(projectUid: string): Map<string, KataIssue> {
  let map = confirmed.get(projectUid);
  if (map === undefined) {
    map = new Map();
    confirmed.set(projectUid, map);
  }
  return map;
}

/**
 * Recompute one project's shown list (its status view) and open count from
 * the layers. A confirmed issue is dropped only once every list computed
 * here reflects it, so switching views never shows a stale server copy.
 */
function recompute(projectUid: string) {
  const view = statusOf(projectUid);
  const mine = confirmedFor(projectUid);
  const edits = pending.filter((edit) => edit.projectUid === projectUid);
  const kept = lingering.get(projectUid) ?? new Map<string, Lingering>();
  const layered = mine.size > 0 || edits.length > 0 || kept.size > 0;
  let settled: Set<string> | null = null;
  const layer = (issues: KataIssue[], forView: StatusView) => {
    if (!layered) return issues;
    const result = reconcile(issues, mine, edits, forView === view ? kept : new Map(), forView);
    settled = settled === null ? new Set(result.settled) : new Set(result.settled.filter((uid) => settled!.has(uid)));
    if (forView === view) {
      for (const uid of result.unlingered) kept.delete(uid);
      for (const [uid, entry] of result.lingered) kept.set(uid, entry);
    }
    return result.issues;
  };
  const next: Partial<ViewerState> = {};
  const open = serverLists.get(listKey(projectUid, "open"));
  if (open?.issues) {
    const issues = layer(open.issues, "open");
    next.openCounts = { ...state.openCounts, [projectUid]: issues.filter((i) => i.status === "open").length };
    if (view === "open") next.lists = { ...state.lists, [projectUid]: { ...open, issues } };
  } else if (view === "open" && open) {
    next.lists = { ...state.lists, [projectUid]: open };
  }
  if (view !== "open") {
    const shown = serverLists.get(listKey(projectUid, view));
    if (shown) {
      next.lists = { ...state.lists, [projectUid]: shown.issues ? { ...shown, issues: layer(shown.issues, view) } : shown };
    }
  }
  for (const uid of settled ?? []) mine.delete(uid);
  if (Object.keys(next).length > 0) patch(next);
}

/** Monotonic per-project request ids so a slow response never overwrites a newer one. */
const listRequests = new Map<string, number>();

async function fetchList(rpc: Rpc, uid: string, view: StatusView): Promise<void> {
  const key = listKey(uid, view);
  const id = (listRequests.get(key) ?? 0) + 1;
  listRequests.set(key, id);
  try {
    const result = await rpc.call("issues.list", { projectUid: uid, status: view });
    if (listRequests.get(key) !== id) return;
    serverLists.set(key, { issues: result.issues, truncated: result.truncated, error: null });
  } catch (error) {
    if (listRequests.get(key) !== id) return;
    const previous = serverLists.get(key);
    serverLists.set(key, {
      issues: previous?.issues ?? null,
      truncated: previous?.truncated ?? false,
      error: message(error),
    });
  }
  recompute(uid);
}

/**
 * (Re)load a project's open list (kept warm: counts, peers, targets) and,
 * when its tab shows closed or all issues, that list too.
 */
export async function loadList(rpc: Rpc, uid: string): Promise<void> {
  const view = statusOf(uid);
  await Promise.all([fetchList(rpc, uid, "open"), view === "open" ? null : fetchList(rpc, uid, view)]);
}

/**
 * Show a tab's closed / all / open issues. A cached list shows at once and
 * revalidates; the first visit fetches it from the daemon. Lingering rows
 * belong to the view they were made in, so they go.
 */
export function setStatusView(rpc: Rpc, uid: string, view: StatusView) {
  if (statusOf(uid) === view) return;
  lingering.delete(uid);
  const cached = serverLists.get(listKey(uid, view));
  patch({
    status: { ...state.status, [uid]: view },
    ...(cached ? {} : { lists: { ...state.lists, [uid]: { issues: null, truncated: false, error: null } } }),
  });
  if (cached) recompute(uid);
  void fetchList(rpc, uid, view);
}

export function cycleStatusView(rpc: Rpc, uid: string): StatusView {
  const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(statusOf(uid)) + 1) % STATUS_CYCLE.length]!;
  setStatusView(rpc, uid, next);
  return next;
}

export async function loadProjects(rpc: Rpc): Promise<void> {
  try {
    const { projects } = await rpc.call("projects.list");
    patch({ projects, projectsError: null });
  } catch (error) {
    patch({ projectsError: message(error) });
  }
}

/** The server's last word on the daemon (signals only report changes). */
export async function loadDaemonStatus(rpc: Rpc): Promise<void> {
  try {
    const status = await rpc.call("daemon.status");
    // Not yet probed (the tail has not run): assume reachable.
    if (status.available !== null) setDaemon(status.available, status.message);
  } catch {
    // The plugin server itself is unreachable; realtime reconnect will retry.
  }
}

export function setDaemon(available: boolean, text: string | null) {
  if (state.daemon.available === available && state.daemon.message === text) return;
  patch({ daemon: { available, message: text } });
}

// ---- pinned projects (thread panels) -------------------------------------------

/**
 * Projects a mounted thread panel shows, whether or not they are included
 * as tabs: their lists survive `applyIncluded` and follow realtime refreshes.
 * Reference-counted because split panes can show the same project twice.
 */
const pinned = new Map<string, number>();

export function pinProject(rpc: Rpc, uid: string): () => void {
  pinned.set(uid, (pinned.get(uid) ?? 0) + 1);
  if (!state.lists[uid]?.issues) void loadList(rpc, uid);
  return () => {
    const count = (pinned.get(uid) ?? 1) - 1;
    if (count > 0) pinned.set(uid, count);
    else pinned.delete(uid);
  };
}

/** A project whose list this frontend keeps (a tab or a thread panel). */
export const isShown = (uid: string) =>
  (state.included ?? []).includes(uid) || pinned.has(uid) || uid === state.visiting;

export function applyIncluded(rpc: Rpc, uids: string[]) {
  const visiting = state.visiting !== null && !uids.includes(state.visiting) ? state.visiting : null;
  const keep = (uid: string) => uids.includes(uid) || pinned.has(uid) || uid === visiting;
  const lists: Record<string, ProjectList> = {};
  for (const uid of Object.keys(state.lists)) if (keep(uid)) lists[uid] = state.lists[uid]!;
  for (const key of serverLists.keys()) if (!keep(keyProject(key))) serverLists.delete(key);
  const activeUid =
    state.activeUid !== null && (uids.includes(state.activeUid) || state.activeUid === visiting)
      ? state.activeUid
      : (uids[0] ?? null);
  patch({ included: uids, lists, activeUid, visiting });
  for (const uid of uids) if (!state.lists[uid]?.issues) void loadList(rpc, uid);
}

export async function loadIncluded(rpc: Rpc): Promise<void> {
  try {
    const { projectUids } = await rpc.call("included.get");
    applyIncluded(rpc, projectUids);
  } catch (error) {
    patch({ projectsError: message(error) });
  }
}

/** Persist a new included order; the UI updates immediately. */
export async function setIncluded(rpc: Rpc, uids: string[]): Promise<void> {
  const previous = state.included ?? [];
  applyIncluded(rpc, uids);
  try {
    const { projectUids } = await rpc.call("included.set", { projectUids: uids });
    applyIncluded(rpc, projectUids);
  } catch (error) {
    applyIncluded(rpc, previous);
    throw error;
  }
}

/** Refetch everything (first mount, or a realtime reconnect). */
export function refreshAll(rpc: Rpc) {
  void loadDaemonStatus(rpc);
  void loadProjects(rpc);
  void loadIncluded(rpc).then(() => {
    for (const uid of state.included ?? []) void loadList(rpc, uid);
    if (state.visiting !== null) void loadList(rpc, state.visiting);
  });
}

/** Ask the nav page to show an issue (it activates or visits the project). */
export function requestNavIssue(target: IssueTarget) {
  patch({ navTarget: { ...target, seq: (state.navTarget?.seq ?? 0) + 1 } });
}

/** Show a non-included project as an extra tab until another tab is chosen. */
export function visitProject(rpc: Rpc, uid: string) {
  const included = state.included ?? [];
  if (included.includes(uid)) {
    patch({ activeUid: uid, visiting: null });
    return;
  }
  patch({ activeUid: uid, visiting: uid });
  if (!state.lists[uid]?.issues) void loadList(rpc, uid);
}

export function requestPanelFocus() {
  patch({ focusRequest: state.focusRequest + 1 });
}

/** Call right before opening the thread panel deliberately (chip, palette, header). */
export function requestScopedFocus() {
  patch({ scopedFocus: { at: Date.now() } });
}

export function selectIssue(projectUid: string, issueUid: string) {
  if (state.selected[projectUid] === issueUid) return;
  patch({ selected: { ...state.selected, [projectUid]: issueUid } });
}

/** Drop rows kept in place after a close or reopen (on leaving the tab). */
export function clearLingering(projectUid: string) {
  if (!lingering.get(projectUid)?.size) return;
  lingering.delete(projectUid);
  recompute(projectUid);
}

// ---- view options -----------------------------------------------------------

export function expandedFor(projectUid: string): ReadonlySet<string> {
  return state.expanded[projectUid] ?? NO_EXPANDED;
}

export function setExpanded(projectUid: string, uids: Iterable<string>) {
  patch({ expanded: { ...state.expanded, [projectUid]: new Set(uids) } });
}

export function setExpandedOne(projectUid: string, issueUid: string, open: boolean) {
  const current = expandedFor(projectUid);
  if (current.has(issueUid) === open) return;
  const next = new Set(current);
  if (open) next.add(issueUid);
  else next.delete(issueUid);
  setExpanded(projectUid, next);
}

export function setFilter(projectUid: string, filter: string) {
  if ((state.filters[projectUid] ?? "") === filter) return;
  patch({ filters: { ...state.filters, [projectUid]: filter } });
}

export function toggleNested() {
  patch({ nested: !state.nested });
}

// ---- mutations --------------------------------------------------------------

/**
 * Placeholder uid → its real uid once created. Kept for the session (it is
 * tiny) so a mutation queued on a placeholder can always find its ref.
 */
const creations = new Map<string, Promise<string>>();
const TEMP_PREFIX = "tmp-";

export const isPlaceholder = (uid: string) => uid.startsWith(TEMP_PREFIX);

/** A kata ref for an issue, waiting for its create when it is a placeholder. */
async function refFor(uid: string): Promise<string> {
  return creations.get(uid) ?? uid;
}

function renameEverywhere(projectUid: string, from: string, to: string) {
  pending = pending.map((edit) => (edit.issueUid === from ? { ...edit, issueUid: to } : edit));
  const next: Partial<ViewerState> = {};
  if (state.selected[projectUid] === from) next.selected = { ...state.selected, [projectUid]: to };
  const expanded = expandedFor(projectUid);
  if (expanded.has(from)) {
    const set = new Set(expanded);
    set.delete(from);
    set.add(to);
    next.expanded = { ...state.expanded, [projectUid]: set };
  }
  if (Object.keys(next).length > 0) patch(next);
}

function settle(projectUid: string, detail: KataIssueDetail) {
  confirmedFor(projectUid).set(detail.issue.uid, detail.issue);
  rememberDetail(detail);
  patch({ detailVersion: state.detailVersion + 1 });
}

/**
 * Apply `apply` to the shown issue now, send the mutation, then reconcile
 * with the issue it returns. Rejects (after rolling back) when it fails.
 */
async function mutate(
  projectUid: string,
  issueUid: string,
  apply: (issue: KataIssue) => KataIssue | null,
  send: (ref: string) => Promise<KataIssueDetail>,
  /** Runs with the result, in the same update that retires the edit. */
  onSettled?: (detail: KataIssueDetail) => void,
): Promise<KataIssueDetail> {
  const edit: PendingEdit = {
    id: ++nextEditId,
    projectUid,
    issueUid,
    apply: (issue) => (issue === undefined ? undefined : apply(issue)),
  };
  pending = [...pending, edit];
  recompute(projectUid);
  try {
    // Re-read: a placeholder's edit is renamed once its create lands.
    const current = pending.find((p) => p.id === edit.id) ?? edit;
    const detail = await send(await refFor(current.issueUid));
    settle(projectUid, detail);
    onSettled?.(detail);
    return detail;
  } finally {
    pending = pending.filter((p) => p.id !== edit.id);
    recompute(projectUid);
  }
}

const randomKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export interface CreateRequest {
  title: string;
  body?: string;
  parent?: KataIssue;
}

/**
 * Show a placeholder row at once, then create it. Returns the placeholder
 * uid (select it; it is renamed to the real uid when the daemon answers)
 * and the create's outcome.
 */
export function createIssue(
  rpc: Rpc,
  projectUid: string,
  request: CreateRequest,
): { tempUid: string; done: Promise<KataIssueDetail> } {
  const key = randomKey();
  const tempUid = `${TEMP_PREFIX}${key}`;
  const projectName = state.projects?.find((p) => p.uid === projectUid)?.name ?? "";
  const now = new Date().toISOString();
  const parent = request.parent;
  const parentPeer: KataLinkPeer | undefined = parent
    ? {
        uid: parent.uid,
        short_id: parent.short_id,
        qualified_id: parent.qualified_id,
        status: parent.status,
        title: parent.title,
      }
    : undefined;
  const placeholder: KataIssue = {
    id: 0,
    uid: tempUid,
    project_id: 0,
    project_uid: projectUid,
    short_id: "····",
    qualified_id: `${projectName}#····`,
    title: request.title,
    body: request.body ?? "",
    status: "open",
    author: "",
    labels: [],
    revision: 0,
    created_at: now,
    updated_at: now,
    ...(parentPeer ? { parent: parentPeer } : {}),
  };
  const edit: PendingEdit = {
    id: ++nextEditId,
    projectUid,
    issueUid: tempUid,
    apply: (issue) => issue ?? placeholder,
  };
  pending = [...pending, edit];
  if (parent) setExpandedOne(projectUid, parent.uid, true);
  recompute(projectUid);

  let resolveUid!: (uid: string) => void;
  let rejectUid!: (error: unknown) => void;
  const uidPromise = new Promise<string>((resolve, reject) => {
    resolveUid = resolve;
    rejectUid = reject;
  });
  uidPromise.catch(() => {});
  creations.set(tempUid, uidPromise);

  const done = (async () => {
    try {
      const parentRef = parent
        ? isPlaceholder(parent.uid)
          ? await refFor(parent.uid)
          : parent.short_id
        : undefined;
      const detail = await rpc.call("issues.create", {
        projectUid,
        title: request.title,
        ...(request.body?.trim() ? { body: request.body } : {}),
        ...(parentRef ? { parentRef } : {}),
        idempotencyKey: key,
      });
      settle(projectUid, detail);
      pending = pending.filter((p) => p.id !== edit.id);
      renameEverywhere(projectUid, tempUid, detail.issue.uid);
      resolveUid(detail.issue.uid);
      return detail;
    } catch (error) {
      pending = pending.filter((p) => p.id !== edit.id && p.issueUid !== tempUid);
      rejectUid(error);
      throw error;
    } finally {
      recompute(projectUid);
    }
  })();
  return { tempUid, done };
}

export function setPriority(rpc: Rpc, projectUid: string, issueUid: string, priority: number | null) {
  return mutate(
    projectUid,
    issueUid,
    (issue) => {
      const { priority: _old, ...rest } = issue;
      return priority === null ? rest : { ...rest, priority };
    },
    (ref) => rpc.call("issues.setPriority", { projectUid, ref, priority }),
  );
}

export function closeIssue(
  rpc: Rpc,
  projectUid: string,
  issueUid: string,
  close: { reason: CloseReason; message?: string; targetRef?: string },
) {
  const index = state.lists[projectUid]?.issues?.findIndex((issue) => issue.uid === issueUid) ?? -1;
  return mutate(
    projectUid,
    issueUid,
    (issue) => ({ ...issue, status: "closed", closed_reason: close.reason }),
    (ref) =>
      rpc.call("issues.close", {
        projectUid,
        ref,
        reason: close.reason,
        ...(close.message?.trim() ? { message: close.message } : {}),
        ...(close.targetRef?.trim() ? { targetRef: close.targetRef.trim() } : {}),
      }),
    (detail) => {
      let kept = lingering.get(projectUid);
      if (kept === undefined) lingering.set(projectUid, (kept = new Map()));
      kept.set(detail.issue.uid, { issue: detail.issue, index: Math.max(0, index) });
    },
  );
}

export function reopenIssue(rpc: Rpc, projectUid: string, issueUid: string) {
  const shownIndex = state.lists[projectUid]?.issues?.findIndex((issue) => issue.uid === issueUid) ?? -1;
  return mutate(
    projectUid,
    issueUid,
    (issue) => {
      const { closed_reason: _reason, closed_at: _at, ...rest } = issue;
      return { ...rest, status: "open" };
    },
    (ref) => rpc.call("issues.reopen", { projectUid, ref }),
    (detail) => {
      // Stay at this row (not jump to the top) until the list shows it reopened.
      let kept = lingering.get(projectUid);
      if (kept === undefined) lingering.set(projectUid, (kept = new Map()));
      const index = kept.get(detail.issue.uid)?.index ?? Math.max(0, shownIndex);
      kept.set(detail.issue.uid, { issue: detail.issue, index });
    },
  );
}

export function setLabels(
  rpc: Rpc,
  projectUid: string,
  issueUid: string,
  change: { add: string[]; remove: string[] },
) {
  return mutate(
    projectUid,
    issueUid,
    (issue) => {
      const labels = new Set(issue.labels ?? []);
      for (const label of change.remove) labels.delete(label);
      for (const label of change.add) labels.add(label);
      return { ...issue, labels: [...labels].sort() };
    },
    async (ref) => {
      let last: KataIssueDetail | null = null;
      for (const label of change.remove) {
        last = await rpc.call("issues.removeLabel", { projectUid, ref, label });
      }
      for (const label of change.add) {
        last = await rpc.call("issues.addLabel", { projectUid, ref, label });
      }
      return last ?? rpc.call("issues.get", { projectUid, ref });
    },
  );
}

export function editTitle(rpc: Rpc, projectUid: string, issueUid: string, title: string) {
  return mutate(
    projectUid,
    issueUid,
    (issue) => ({ ...issue, title }),
    (ref) => rpc.call("issues.edit", { projectUid, ref, title }),
  );
}

export function editBody(rpc: Rpc, projectUid: string, issueUid: string, body: string) {
  return mutate(
    projectUid,
    issueUid,
    (issue) => ({ ...issue, body }),
    (ref) => rpc.call("issues.edit", { projectUid, ref, body }),
  );
}

export async function addComment(rpc: Rpc, projectUid: string, issueUid: string, body: string) {
  const detail = await rpc.call("issues.comment", {
    projectUid,
    ref: await refFor(issueUid),
    body,
    idempotencyKey: randomKey(),
  });
  settle(projectUid, detail);
  recompute(projectUid);
  return detail;
}

// ---- labels typeahead -------------------------------------------------------

const labelCache = new Map<string, Promise<string[]>>();

export function projectLabels(rpc: Rpc, projectUid: string, refresh = false): Promise<string[]> {
  let cached = labelCache.get(projectUid);
  if (cached === undefined || refresh) {
    cached = rpc
      .call("labels.list", { projectUid })
      .then(({ labels }) => labels.sort((a, b) => b.count - a.count).map((l) => l.label));
    cached.catch(() => labelCache.delete(projectUid));
    labelCache.set(projectUid, cached);
  }
  return cached;
}

// ---- issue detail (comments, children); small LRU ----

const DETAIL_CACHE = 50;
const details = new Map<string, KataIssueDetail>();

export function cachedDetail(issueUid: string): KataIssueDetail | undefined {
  return details.get(issueUid);
}

export function rememberDetail(detail: KataIssueDetail) {
  details.delete(detail.issue.uid);
  details.set(detail.issue.uid, detail);
  while (details.size > DETAIL_CACHE) {
    const oldest = details.keys().next().value;
    if (oldest === undefined) break;
    details.delete(oldest);
  }
}

export function forgetProjectDetails(projectUid: string) {
  for (const [uid, detail] of details) {
    if (detail.issue.project_uid === projectUid) details.delete(uid);
  }
}
