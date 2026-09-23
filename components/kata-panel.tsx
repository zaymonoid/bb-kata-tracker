// The Kata panel: project tabs over a list/detail split, driven from the
// keyboard through lib/keymap.ts. The nav page shows every included project
// as a tab; a thread's "Kata issues" panel passes a `scope` instead, pinning
// the panel to the thread's kata-bound project with no tabs or picker. Keys
// are handled on the panel root, so they apply only while focus is inside
// the panel; text fields keep their keys (components/fields.tsx). Every
// mutation is optimistic through lib/viewer-store.ts and never waits before
// the next key. Below NARROW_PX (a thread side panel) the list and the
// detail take turns at full width: enter shows the detail, esc the list.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { KataComment, KataIssue, KataIssueDetail, KataLinkPeer } from "@/lib/kata-types";
import {
  CHORD_TIMEOUT_MS,
  handleKey,
  initialKeymapState,
  pendingHint,
  type KeyCommand,
  type KeymapState,
  type Pane,
} from "@/lib/keymap";
import { buildRows, parentUids, visibleRowFor } from "@/lib/tree";
import type { KataRpcContract } from "@/lib/rpc-contract";
import { KATA_CHANNEL, type KataSignal } from "@/lib/signals";
import {
  addComment,
  applyIncluded,
  cachedDetail,
  clearLingering,
  closeIssue,
  createIssue,
  cycleStatusView,
  editBody,
  editTitle,
  expandedFor,
  forgetProjectDetails,
  isPlaceholder,
  isShown,
  loadDaemonStatus,
  loadList,
  loadProjects,
  patch,
  pinProject,
  projectLabels,
  refreshAll,
  rememberDetail,
  reopenIssue,
  selectIssue,
  setDaemon,
  setExpanded,
  setExpandedOne,
  setFilter,
  setIncluded,
  setLabels,
  setPriority,
  setStatusView,
  statusOf,
  toggleNested,
  viewerStore,
  visitProject,
} from "@/lib/viewer-store";
import type { IssueTarget } from "@/lib/refs";
import {
  clampFraction,
  DEFAULT_LIST_FRACTION,
  fractionFromPointer,
  readFraction,
} from "@/lib/split";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState, Kbd } from "@/components/issue-bits";
import { HelpOverlay } from "@/components/help-overlay";
import { IssueDetail } from "@/components/issue-detail";
import { IssueList, ROW_HEIGHT } from "@/components/issue-list";
import { BodyDialog, CloseDialog, CommentDialog, type CloseValues } from "@/components/dialogs";
import { DraftRow, FilterBar, LabelBar, TitleEditor, type Draft } from "@/components/editors";
import { ProjectPicker } from "@/components/project-picker";
import { ProjectTabs } from "@/components/project-tabs";
import { moveToSlot, shiftBy } from "@/lib/reorder";

const DETAIL_DEBOUNCE_MS = 120;
const FLASH_MS = 1800;
const DETAIL_SCROLL_STEP = 80;

const ERROR_FLASH_MS = 6000;
/** Narrower than this, list and detail take turns at full width. */
export const NARROW_PX = 720;

const STATUS_TEXT = {
  open: "Open issues",
  all: "All issues (open and closed)",
  closed: "Closed issues · r: reopen",
} as const;

/** Commands that change kata; refused up front while the daemon is unreachable. */
const MUTATING = new Set<KeyCommand["type"]>([
  "newIssue",
  "newChild",
  "setPriority",
  "close",
  "closeDone",
  "reopen",
  "comment",
  "label",
  "editTitle",
  "editBody",
  "linkThread",
]);

type Flash = { text: string; tone: "info" | "error" };

type Dialog =
  | { kind: "close"; issueUid: string; label: string; initial?: CloseValues; error: string | null }
  | { kind: "comment"; issueUid: string; label: string; initial?: string; error: string | null }
  | { kind: "body"; issueUid: string; label: string; initial: string; original: string; error: string | null };

export interface PendingComment {
  id: string;
  issueUid: string;
  body: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function isSignal(value: unknown): value is KataSignal {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Pins the panel to one project (a thread's bound kata project). */
export interface KataPanelScope {
  projectUid: string;
  /** Issue linked to the host thread: preselected and marked. */
  linkedIssueUid: string | null;
  /** `L`: link the selected issue to the host thread. */
  onLink: (issue: KataIssue) => void;
  /** An issue to show (panel `params`); wins over the linked issue. */
  target?: IssueTarget | null;
}

/** Requests from a deliberate open (chip, palette, header) for the next thread panel to take focus. */
const SCOPED_FOCUS_WINDOW_MS = 3000;

/** Mirror of the nav page's split, read before the RPC answers (first paint). */
const SPLIT_STORAGE_KEY = "kata.split.nav";
/** The host may move focus during a route change; claim it again after the frame. */
const FOCUS_CLAIM_MS = 150;

function storedFraction(): number | null {
  try {
    return readFraction(window.localStorage.getItem(SPLIT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function KataPanel({ scope }: { scope?: KataPanelScope | undefined } = {}) {
  const rpc = useRpc<KataRpcContract>();
  const scopedUid = scope?.projectUid ?? null;
  const view = useSyncExternalStore(viewerStore.subscribe, viewerStore.get);
  const [pane, setPane] = useState<Pane>("list");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [keyState, setKeyState] = useState<KeymapState>(initialKeymapState);
  const keyStateRef = useRef(keyState);
  const [flash, setFlashState] = useState<Flash | null>(null);
  const [detail, setDetail] = useState<KataIssueDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [filterFocus, setFilterFocus] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [labelFor, setLabelFor] = useState<string | null>(null);
  const [knownLabels, setKnownLabels] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [pendingComments, setPendingComments] = useState<PendingComment[]>([]);
  const [hasFocus, setHasFocus] = useState(false);
  /** Focus was in the panel and has not moved to anything else (it may sit on <body> after the list re-rendered). */
  const wantsFocus = useRef(false);
  const [width, setWidth] = useState<number | null>(null);
  /** Nav page only: the list's share of the panel, durable per user (layout.get/set). */
  const [listFraction, setListFraction] = useState(() =>
    scope ? DEFAULT_LIST_FRACTION : (storedFraction() ?? DEFAULT_LIST_FRACTION),
  );
  const [dragging, setDragging] = useState(false);
  /** A drag that beat the RPC answer wins over it. */
  const splitTouched = useRef(false);
  const splitRowRef = useRef<HTMLDivElement | null>(null);
  const splitMetrics = useRef({ left: 0, width: 0 });
  const focusBeforeDrag = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const setFlash = useCallback((text: string | null, tone: Flash["tone"] = "info") => {
    setFlashState(text === null ? null : { text, tone });
  }, []);
  const flashError = useCallback((what: string, error: unknown) => {
    setFlashState({ text: `${what}: ${errorText(error)}`, tone: "error" });
  }, []);

  // ---- data ----------------------------------------------------------------

  // Cached lists render at once; this revalidates them in the background.
  const revalidate = useCallback(() => {
    if (scopedUid === null) return refreshAll(rpc);
    void loadDaemonStatus(rpc);
    void loadProjects(rpc);
    void loadList(rpc, scopedUid);
  }, [rpc, scopedUid]);
  useEffect(revalidate, [revalidate]);

  useEffect(() => (scopedUid === null ? undefined : pinProject(rpc, scopedUid)), [rpc, scopedUid]);

  const activeUidRef = useRef(view.activeUid);
  activeUidRef.current = view.activeUid;
  useRealtime(KATA_CHANNEL, (payload) => {
    if (!isSignal(payload)) return;
    switch (payload.type) {
      case "issues.changed":
        if (!isShown(payload.projectUid)) return;
        forgetProjectDetails(payload.projectUid);
        void loadList(rpc, payload.projectUid);
        if (payload.projectUid === activeUidRef.current) setDetailNonce((n) => n + 1);
        return;
      case "included.changed":
        applyIncluded(rpc, payload.projectUids);
        return;
      case "daemon.status":
        setDaemon(payload.available, payload.message);
        // Back: re-sync everything that may have changed meanwhile, no reload needed.
        if (payload.available) revalidate();
        return;
    }
  });

  // Signals are not replayed: reconcile after a realtime reconnect.
  const connection = useRealtimeConnectionState();
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (connection === "reconnecting") wasDisconnected.current = true;
    if (connection === "connected" && wasDisconnected.current) {
      wasDisconnected.current = false;
      revalidate();
    }
  }, [connection, revalidate]);

  const included = useMemo(
    () => (scopedUid === null ? (view.included ?? []) : [scopedUid]),
    [scopedUid, view.included],
  );
  // Tabs: the included projects plus one being visited for a target.
  const visiting = scopedUid === null && view.visiting !== null && !included.includes(view.visiting) ? view.visiting : null;
  const tabs = useMemo(() => (visiting === null ? included : [...included, visiting]), [included, visiting]);
  const activeUid = scopedUid ?? view.activeUid;
  const statusView = activeUid ? (view.status[activeUid] ?? "open") : "open";
  const ready = scopedUid !== null || view.included !== null;
  const list = activeUid ? view.lists[activeUid] : undefined;
  const issues = list?.issues ?? [];
  const filter = activeUid ? (view.filters[activeUid] ?? "") : "";
  const expanded = activeUid ? expandedFor(activeUid) : undefined;
  const rows = useMemo(
    () => buildRows(issues, { nested: view.nested, expanded: expanded ?? new Set(), filter }),
    [issues, view.nested, expanded, filter],
  );

  // Selection: the stored uid, or its nearest visible ancestor when it is
  // collapsed away; if it vanished (closed elsewhere), stay at its index.
  const storedSelection = activeUid ? view.selected[activeUid] : undefined;
  const lastIndex = useRef(0);
  const shownSelection =
    storedSelection === undefined ? null : visibleRowFor(storedSelection, rows, issues);
  let selectedIndex = shownSelection === null ? -1 : rows.findIndex((row) => row.issue.uid === shownSelection);
  if (selectedIndex === -1) selectedIndex = Math.min(lastIndex.current, rows.length - 1);
  selectedIndex = Math.max(0, selectedIndex);
  lastIndex.current = selectedIndex;
  const selectedRow = rows[selectedIndex] ?? null;
  const selectedIssue = selectedRow?.issue ?? null;
  const selectedUid = selectedIssue?.uid ?? null;

  // Detail (comments, children) for the selection, debounced so holding `j`
  // does not fire a request per row.
  useEffect(() => {
    setDetailError(null);
    if (activeUid === null || selectedUid === null) {
      setDetail(null);
      return;
    }
    setDetail(cachedDetail(selectedUid) ?? null);
    if (isPlaceholder(selectedUid)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("issues.get", { projectUid: activeUid, ref: selectedUid }).then(
        (result) => {
          rememberDetail(result);
          if (!cancelled) setDetail(result);
        },
        (error: unknown) => {
          if (!cancelled) setDetailError(errorText(error));
        },
      );
    }, DETAIL_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, activeUid, selectedUid, detailNonce]);

  // A mutation just returned fresh detail for the selection.
  useEffect(() => {
    if (selectedUid === null) return;
    const cached = cachedDetail(selectedUid);
    if (cached) setDetail(cached);
  }, [view.detailVersion, selectedUid]);

  // ---- focus ---------------------------------------------------------------

  const focusList = useCallback(() => {
    wantsFocus.current = true;
    (listRef.current ?? rootRef.current)?.focus({ preventScroll: true });
    setPane("list");
  }, []);

  // Width decides the layout; a thread side panel is usually narrow.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const narrow = width !== null && width < NARROW_PX;
  /** The boundary is dragged only on the nav page's wide layout. */
  const splitWide = scopedUid === null && !narrow;
  const splitFraction = clampFraction(listFraction, width ?? 0);

  // ---- the list/detail split (nav page) ------------------------------------

  // The stored split follows the user across tabs and reloads; localStorage
  // only carries it to the first paint, before this answers.
  useEffect(() => {
    if (scopedUid !== null) return;
    let cancelled = false;
    void rpc.call("layout.get", { surface: "nav" }).then(
      ({ listFraction: stored }) => {
        const fraction = readFraction(stored);
        if (cancelled || fraction === null || splitTouched.current) return;
        setListFraction(fraction);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, scopedUid]);

  const saveSplit = useCallback(
    (fraction: number) => {
      if (readFraction(fraction) === null) return;
      try {
        window.localStorage.setItem(SPLIT_STORAGE_KEY, String(fraction));
      } catch {
        // Private mode: the RPC still carries it.
      }
      void rpc.call("layout.set", { surface: "nav", listFraction: fraction }).catch(() => {});
    },
    [rpc],
  );

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const row = splitRowRef.current;
    if (event.button !== 0 || !row) return;
    const rect = row.getBoundingClientRect();
    splitMetrics.current = { left: rect.left, width: rect.width };
    focusBeforeDrag.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A pointerdown on the handle would hand focus to the panel root.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    splitTouched.current = true;
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const { left, width: rowWidth } = splitMetrics.current;
    setListFraction(fractionFromPointer(event.clientX, left, rowWidth));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    saveSplit(clampFraction(listFraction, splitMetrics.current.width || (width ?? 0)));
    // The keyboard stays where it was before the drag.
    const previous = focusBeforeDrag.current;
    if (previous && previous.isConnected && document.activeElement !== previous) {
      previous.focus({ preventScroll: true });
    }
  };

  const resetSplit = () => {
    splitTouched.current = true;
    setListFraction(DEFAULT_LIST_FRACTION);
    saveSplit(DEFAULT_LIST_FRACTION);
  };

  // Narrow: the pane that is shown gets focus when the panel (or nothing) had it.
  useLayoutEffect(() => {
    if (!narrow) return;
    const active = document.activeElement;
    if (active !== document.body && !rootRef.current?.contains(active)) return;
    const target = pane === "detail" ? detailRef.current : listRef.current;
    if (target && !target.contains(active)) target.focus({ preventScroll: true });
  }, [narrow, pane]);

  // Loading finished while the panel held focus (on its root, or lost to
  // <body> when the old list unmounted): hand it to the list.
  const listShown = list?.issues != null;
  useEffect(() => {
    const active = document.activeElement;
    const lost = active === rootRef.current || ((active === document.body || active === null) && wantsFocus.current);
    if (listShown && lost && pane === "list") listRef.current?.focus({ preventScroll: true });
  }, [listShown, activeUid, statusView, pane]);

  // The nav page is a page of its own: opening it (the sidebar row, ⌘⇧K, or
  // navigating back to it) puts the keyboard on the list, so `j` works without
  // a click. The host moves focus during a route change, so the claim is made
  // again after the frame and once the list has rows. A thread panel never
  // claims focus (T6): it would take it from the composer.
  const claimFocus = useCallback(() => {
    if (scopedUid !== null) return;
    const active = document.activeElement;
    if (rootRef.current?.contains(active) || isTypingTarget(active)) return;
    focusList();
  }, [scopedUid, focusList]);
  useEffect(() => {
    if (scopedUid !== null) return;
    claimFocus();
    const frame = requestAnimationFrame(claimFocus);
    const timer = setTimeout(claimFocus, FOCUS_CLAIM_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [scopedUid, claimFocus, listShown]);

  // The palette command's focus request is for the nav page. A thread panel
  // does not take focus from the composer by itself, only when it was opened
  // deliberately (a chip, the palette, the header's "Open Kata issues").
  const focusRequest = scopedUid === null ? view.focusRequest : null;
  useEffect(() => {
    if (focusRequest !== null) focusList();
  }, [focusRequest, ready, focusList]);
  const scopedFocus = scopedUid !== null ? view.scopedFocus : null;
  useEffect(() => {
    if (scopedFocus === null || Date.now() - scopedFocus.at > SCOPED_FOCUS_WINDOW_MS) return;
    patch({ scopedFocus: null });
    focusList();
  }, [scopedFocus, focusList]);

  // Preselect the panel's target, else the thread's linked issue (when either changes, too).
  const linkedUid = scope?.linkedIssueUid ?? null;
  const scopeTarget = scope?.target ?? null;
  const preselectUid = scopeTarget?.issueUid ?? linkedUid;
  const [pendingTarget, setPendingTarget] = useState<IssueTarget | null>(null);
  useEffect(() => {
    if (scopedUid === null || preselectUid === null) return;
    selectIssue(scopedUid, preselectUid);
    if (scopeTarget) setPendingTarget(scopeTarget);
  }, [scopedUid, preselectUid, scopeTarget]);

  // The nav page's target (issue chip or palette outside a thread): consumed once.
  const navTarget = scopedUid === null ? view.navTarget : null;
  useEffect(() => {
    if (navTarget === null || !ready) return;
    patch({ navTarget: null });
    if (activeUid !== null && activeUid !== navTarget.projectUid) {
      clearLingering(activeUid);
      resetTabUi();
    }
    visitProject(rpc, navTarget.projectUid);
    selectIssue(navTarget.projectUid, navTarget.issueUid);
    setPendingTarget(navTarget);
    focusList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTarget, ready]);

  // A target missing from the open list is closed (or gone): show all issues.
  const targetList = pendingTarget ? view.lists[pendingTarget.projectUid]?.issues : undefined;
  useEffect(() => {
    if (pendingTarget === null || !targetList) return;
    const { projectUid, issueUid, qualifiedId } = pendingTarget;
    if (targetList.some((issue) => issue.uid === issueUid)) return setPendingTarget(null);
    const name = qualifiedId ?? "That issue";
    if (statusOf(projectUid) === "open") {
      // Keep the target pending: the all list loads next, and this checks again.
      setStatusView(rpc, projectUid, "all");
      selectIssue(projectUid, issueUid);
      setFlash(`${name} is not open; showing all issues (s cycles)`);
      return;
    }
    setPendingTarget(null);
    setFlash(`${name} is not in this list`);
  }, [pendingTarget, targetList, setFlash, rpc]);

  // ---- transient hints -----------------------------------------------------

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlashState(null), flash.tone === "error" ? ERROR_FLASH_MS : FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    if (keyState.pending === null) return;
    const timer = setTimeout(() => {
      keyStateRef.current = initialKeymapState;
      setKeyState(initialKeymapState);
    }, CHORD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [keyState]);

  // ---- commands ------------------------------------------------------------

  const select = useCallback(
    (uid: string) => {
      if (activeUid !== null) selectIssue(activeUid, uid);
    },
    [activeUid],
  );

  const selectIndex = (index: number) => {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (row) select(row.issue.uid);
  };

  const resetTabUi = () => {
    setDraft(null);
    setEditingUid(null);
    setLabelFor(null);
    setFilterOpen(false);
  };

  const activate = (uid: string) => {
    if (uid === activeUid || scopedUid !== null) return;
    if (activeUid !== null) clearLingering(activeUid);
    resetTabUi();
    if (!view.lists[uid]?.issues) parkFocus();
    // Leaving a visited project drops its tab.
    patch({ activeUid: uid, ...(visiting !== null && uid !== visiting ? { visiting: null } : {}) });
  };

  /** Persist a new tab order (drag, `alt-[` / `alt-]`, the picker). */
  const saveOrder = (next: readonly string[]) => {
    if (next === included) return;
    setIncluded(rpc, [...next]).catch((error: unknown) => flashError("Could not save projects", error));
  };

  const moveTab = (delta: 1 | -1) => {
    if (scopedUid !== null || activeUid === null) return;
    if (activeUid === visiting) return setFlash("visiting tab · not saved");
    saveOrder(shiftBy(included, activeUid, delta));
  };

  const switchTab = (delta: number) => {
    if (tabs.length === 0) return;
    const index = activeUid === null ? -1 : tabs.indexOf(activeUid);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next !== undefined) activate(next);
  };

  const toggleRow = useCallback(
    (uid: string) => {
      if (activeUid === null) return;
      setExpandedOne(activeUid, uid, !expandedFor(activeUid).has(uid));
    },
    [activeUid],
  );

  /** Where focus actually is right now; React state can lag a fast key. */
  const currentPane = (): Pane =>
    detailRef.current?.contains(document.activeElement) ? "detail" : "list";

  const labelOf = (issue: KataIssue) => issue.qualified_id;

  const startDraft = (parent: KataIssue | null) => {
    if (activeUid === null) return;
    if (filter !== "") setFilter(activeUid, "");
    setFilterOpen(false);
    setEditingUid(null);
    setLabelFor(null);
    if (parent) setExpandedOne(activeUid, parent.uid, true);
    setDraft((current) =>
      current && current.parentUid === (parent?.uid ?? null)
        ? current
        : { parentUid: parent?.uid ?? null, title: "", body: "", showBody: false, error: null },
    );
    // Already open (same parent): the row keeps its text, just refocus it.
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLInputElement>("[data-draft-row] input")?.focus(),
    );
  };

  const saveDraft = (saved: Draft) => {
    if (activeUid === null) return;
    const projectUid = activeUid;
    const parent = saved.parentUid ? issues.find((issue) => issue.uid === saved.parentUid) : undefined;
    const { tempUid, done } = createIssue(rpc, projectUid, {
      title: saved.title.trim(),
      body: saved.body,
      ...(parent ? { parent } : {}),
    });
    setDraft(null);
    selectIssue(projectUid, tempUid);
    focusList();
    done.catch((error: unknown) => {
      flashError("Create failed", error);
      // Hand the text back so nothing typed is lost.
      if (activeUidRef.current === projectUid) {
        setDraft((current) => current ?? { ...saved, error: `Not saved: ${errorText(error)}` });
      }
    });
  };

  /**
   * The list is about to be replaced (a view or tab still loading): park
   * focus on the panel root so keys keep working; it returns to the list
   * once that renders.
   */
  const parkFocus = () => {
    if (rootRef.current?.contains(document.activeElement)) rootRef.current.focus({ preventScroll: true });
  };

  /** Narrow detail view: go back to the list, where editors live. */
  const showList = () => {
    if (narrow) setPane("list");
  };

  const needIssue = (): KataIssue | null => {
    if (selectedIssue === null) setFlash("No issue selected");
    return selectedIssue;
  };

  const run = (command: KeyCommand, activePane: Pane) => {
    const detailEl = detailRef.current;
    const inDetail = activePane === "detail";
    if (MUTATING.has(command.type) && !view.daemon.available) {
      return setFlash("kata daemon unreachable — edits are paused until it is back (retrying…)", "error");
    }
    switch (command.type) {
      case "move":
        return selectIndex(selectedIndex + command.delta);
      case "page": {
        if (inDetail && detailEl) {
          detailEl.scrollBy({ top: command.direction * detailEl.clientHeight * 0.9 });
          return;
        }
        const pageRows = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
        return selectIndex(selectedIndex + command.direction * pageRows);
      }
      case "top":
        if (inDetail) return detailEl?.scrollTo({ top: 0 });
        return selectIndex(0);
      case "bottom":
        if (inDetail) return detailEl?.scrollTo({ top: detailEl.scrollHeight });
        return selectIndex(rows.length - 1);
      case "scrollDetail":
        return detailEl?.scrollBy({ top: command.delta * DETAIL_SCROLL_STEP });
      case "focusDetail":
        // Narrow: the detail is hidden until this render; the layout effect focuses it.
        detailEl?.focus({ preventScroll: true });
        return setPane("detail");
      case "focusList":
        return focusList();
      case "tab":
        return switchTab(command.delta);
      case "moveTab":
        return moveTab(command.delta);
      case "help":
        return setHelpOpen((open) => !open);
      case "clearFilter":
        if (activeUid) setFilter(activeUid, "");
        return setFilterOpen(false);
      case "search":
        showList();
        setFilterOpen(true);
        return setFilterFocus((n) => n + 1);
      case "toggleView":
        toggleNested();
        return setFlash(viewerStore.get().nested ? "Nested view" : "Flat view");
      case "expand":
        if (!selectedRow || activeUid === null) return;
        if (selectedRow.childCount > 0 && !selectedRow.expanded) return toggleRow(selectedRow.issue.uid);
        if (selectedRow.expanded) return selectIndex(selectedIndex + 1);
        return;
      case "collapse":
        if (!selectedRow) return;
        if (selectedRow.expanded) return toggleRow(selectedRow.issue.uid);
        if (selectedRow.parentUid) return select(selectedRow.parentUid);
        return;
      case "toggle":
        if (selectedRow && selectedRow.childCount > 0) toggleRow(selectedRow.issue.uid);
        return;
      case "toggleAll": {
        if (activeUid === null) return;
        if (!view.nested) return setFlash("flat view · v: nested");
        const parents = parentUids(issues);
        const open = expandedFor(activeUid);
        const allOpen = parents.every((uid) => open.has(uid));
        setExpanded(activeUid, allOpen ? [] : parents);
        return setFlash(allOpen ? "Collapsed all" : "Expanded all");
      }
      case "cycleStatus": {
        if (activeUid === null) return;
        setDraft(null);
        setEditingUid(null);
        setLabelFor(null);
        if (pane === "list") parkFocus();
        return setFlash(STATUS_TEXT[cycleStatusView(rpc, activeUid)]);
      }
      case "newIssue":
        showList();
        // New issues are open: a closed view would hide the draft's result.
        if (activeUid !== null && statusView === "closed") {
          parkFocus();
          setStatusView(rpc, activeUid, "open");
          setFlash("Open issues");
        }
        return startDraft(null);
      case "newChild": {
        const parent = needIssue();
        if (parent === null) return;
        showList();
        if (parent.status === "closed") return setFlash("parent closed · r: reopen");
        if (!view.nested) toggleNested();
        return startDraft(parent);
      }
      case "setPriority": {
        const issue = needIssue();
        if (issue === null || activeUid === null) return;
        const { priority } = command;
        setPriority(rpc, activeUid, issue.uid, priority).catch((error: unknown) =>
          flashError(`Priority on ${issue.short_id} failed`, error),
        );
        return;
      }
      case "close": {
        const issue = needIssue();
        if (issue === null) return;
        if (issue.status === "closed") return setFlash(`${issue.short_id} is closed · r: reopen`);
        return setDialog({ kind: "close", issueUid: issue.uid, label: labelOf(issue), error: null });
      }
      case "closeDone": {
        const issue = needIssue();
        if (issue === null) return;
        if (issue.status === "closed") return setFlash(`${issue.short_id} is closed · r: reopen`);
        return submitClose(issue.uid, labelOf(issue), { reason: "done", message: "", targetRef: "" });
      }
      case "reopen": {
        const issue = needIssue();
        if (issue === null || activeUid === null) return;
        if (issue.status !== "closed") return setFlash(`${issue.short_id} is open`);
        reopenIssue(rpc, activeUid, issue.uid).then(
          () => setFlash(`Reopened ${issue.short_id}`),
          (error: unknown) => flashError(`Reopen ${issue.short_id} failed`, error),
        );
        return;
      }
      case "comment": {
        const issue = needIssue();
        if (issue === null) return;
        return setDialog({ kind: "comment", issueUid: issue.uid, label: labelOf(issue), error: null });
      }
      case "label": {
        const issue = needIssue();
        if (issue === null || activeUid === null) return;
        showList();
        setDraft(null);
        setEditingUid(null);
        setLabelFor(issue.uid);
        projectLabels(rpc, activeUid, true).then(setKnownLabels, () => setKnownLabels([]));
        return;
      }
      case "editTitle": {
        const issue = needIssue();
        if (issue === null) return;
        showList();
        setDraft(null);
        setLabelFor(null);
        return setEditingUid(issue.uid);
      }
      case "editBody": {
        const issue = needIssue();
        if (issue === null) return;
        if (isPlaceholder(issue.uid)) return setFlash("Still saving…");
        return setDialog({
          kind: "body",
          issueUid: issue.uid,
          label: labelOf(issue),
          initial: issue.body,
          original: issue.body,
          error: null,
        });
      }
      case "copyRef": {
        const issue = needIssue();
        if (issue === null) return;
        if (isPlaceholder(issue.uid)) return setFlash("Still saving…");
        const ref = issue.qualified_id;
        navigator.clipboard.writeText(ref).then(
          () => toast.success(`Copied ${ref}`),
          (error: unknown) => toast.error(`Could not copy: ${errorText(error)}`),
        );
        return;
      }
      case "linkThread": {
        if (!scope) return setFlash("L: link issue (thread panel only)");
        const issue = needIssue();
        if (issue === null) return;
        if (isPlaceholder(issue.uid)) return setFlash("Still saving…");
        if (issue.uid === linkedUid) return setFlash(`${issue.qualified_id} is already linked`);
        scope.onLink(issue);
        return setFlash(`Linking ${issue.qualified_id}…`);
      }
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (pickerOpen || dialog !== null || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (helpOpen) {
      if (event.key === "?" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setHelpOpen(false);
      }
      return;
    }
    const activePane = currentPane();
    const result = handleKey(keyStateRef.current, event, activePane, {
      typing: isTypingTarget(event.target),
      filterActive: filter !== "",
    });
    keyStateRef.current = result.state;
    setKeyState(result.state);
    if (result.handled) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (result.command) run(result.command, activePane);
  };

  // ---- editors -------------------------------------------------------------

  const submitClose = (issueUid: string, label: string, values: CloseValues) => {
    if (activeUid === null) return;
    const projectUid = activeUid;
    setDialog(null);
    focusList();
    closeIssue(rpc, projectUid, issueUid, values).then(
      () => setFlash(`Closed ${label} (${values.reason}) · r: reopen`),
      (error: unknown) => {
        flashError(`Close ${label} failed`, error);
        setDialog({ kind: "close", issueUid, label, initial: values, error: errorText(error) });
      },
    );
  };

  const submitComment = (issueUid: string, label: string, body: string) => {
    if (activeUid === null) return;
    const projectUid = activeUid;
    const id = `c${Date.now()}${Math.random()}`;
    setDialog(null);
    focusList();
    setPendingComments((list) => [...list, { id, issueUid, body }]);
    addComment(rpc, projectUid, issueUid, body).then(
      () => {
        setPendingComments((list) => list.filter((c) => c.id !== id));
        setFlash(`Commented on ${label}`);
      },
      (error: unknown) => {
        setPendingComments((list) => list.filter((c) => c.id !== id));
        flashError(`Comment on ${label} failed`, error);
        setDialog({ kind: "comment", issueUid, label, initial: body, error: errorText(error) });
      },
    );
  };

  const submitBody = (issueUid: string, label: string, original: string, body: string) => {
    if (activeUid === null) return;
    const projectUid = activeUid;
    setDialog(null);
    focusList();
    editBody(rpc, projectUid, issueUid, body).then(
      () => setFlash(`Saved the body of ${label}`),
      (error: unknown) => {
        flashError(`Saving the body of ${label} failed`, error);
        setDialog({ kind: "body", issueUid, label, initial: body, original, error: errorText(error) });
      },
    );
  };

  const labelIssue = labelFor ? issues.find((issue) => issue.uid === labelFor) ?? null : null;
  const editingIssue = editingUid ? issues.find((issue) => issue.uid === editingUid) ?? null : null;
  const draftParentRow = draft?.parentUid ? rows.find((row) => row.issue.uid === draft.parentUid) : undefined;

  const draftSlot =
    draft === null || activeUid === null
      ? null
      : {
          afterUid: draft.parentUid,
          node: (
            <DraftRow
              key={draft.parentUid ?? "top"}
              draft={draft}
              depth={draftParentRow ? draftParentRow.depth + 1 : 0}
              parentLabel={draftParentRow ? draftParentRow.issue.short_id : null}
              onChange={setDraft}
              onSave={saveDraft}
              onCancel={() => {
                setDraft(null);
                focusList();
              }}
            />
          ),
        };

  const editingSlot =
    editingIssue === null || activeUid === null
      ? null
      : {
          uid: editingIssue.uid,
          node: (
            <TitleEditor
              key={editingIssue.uid}
              initial={editingIssue.title}
              onCancel={() => {
                setEditingUid(null);
                focusList();
              }}
              onSave={(title) => {
                const projectUid = activeUid;
                setEditingUid(null);
                focusList();
                editTitle(rpc, projectUid, editingIssue.uid, title).catch((error: unknown) =>
                  flashError(`Rename ${editingIssue.short_id} failed`, error),
                );
              }}
            />
          ),
        };

  // ---- peers ---------------------------------------------------------------

  const titleOf = useCallback(
    (peer: KataLinkPeer) => {
      if (peer.title) return peer.title;
      for (const projectList of Object.values(view.lists)) {
        const found = projectList.issues?.find((issue) => issue.uid === peer.uid);
        if (found) return found.title;
      }
      return undefined;
    },
    [view.lists],
  );

  const openPeer = (peer: KataLinkPeer) => {
    for (const uid of tabs) {
      if (view.lists[uid]?.issues?.some((issue) => issue.uid === peer.uid)) {
        activate(uid);
        selectIssue(uid, peer.uid);
        listRef.current?.focus({ preventScroll: true });
        return;
      }
    }
    setFlash(`${peer.qualified_id} is not an open issue in an included project`);
  };

  const counts = useMemo(() => {
    const result: Record<string, number | undefined> = {};
    for (const uid of tabs) result[uid] = view.openCounts[uid];
    return result;
  }, [tabs, view.openCounts]);

  const shownComments: KataComment[] = pendingComments
    .filter((comment) => comment.issueUid === selectedUid)
    .map((comment) => ({ uid: comment.id, author: "sending…", body: comment.body, created_at: "" }));

  // ---- render --------------------------------------------------------------

  /** The divider shows which pane has the keyboard (there is no focus ring). */
  const detailFocused = hasFocus && pane === "detail";
  const pendingText = pendingHint(keyState);
  const hint: Flash | null = pendingText ? { text: pendingText, tone: "info" } : flash;
  const showFilter = filterOpen || filter !== "";

  let body;
  if (!ready) {
    body = view.projectsError ? (
      <EmptyState>Could not reach the Kata plugin: {view.projectsError}</EmptyState>
    ) : (
      <EmptyState>Loading…</EmptyState>
    );
  } else if (tabs.length === 0) {
    body = (
      <EmptyState>
        <p>No kata projects included yet.</p>
        <Button className="mt-3" size="sm" onClick={() => setPickerOpen(true)}>
          Choose projects
        </Button>
        <p className="mt-2 text-xs">Or use the + tab above.</p>
      </EmptyState>
    );
  } else {
    body = (
      <div ref={splitRowRef} className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex min-h-0 flex-col",
            narrow
              ? pane === "detail"
                ? "hidden"
                : "w-full"
              : splitWide
                ? "shrink-0"
                : // No handle here, so this border is the boundary's only line.
                  cn("w-[45%] min-w-72 max-w-2xl border-r", detailFocused ? "border-ring/50" : "border-border"),
          )}
          {...(splitWide ? { style: { width: `${splitFraction * 100}%` } } : {})}
        >
          {showFilter && activeUid ? (
            <FilterBar
              key={activeUid}
              value={filter}
              autoFocus={filterOpen}
              focusNonce={filterFocus}
              onChange={(value) => setFilter(activeUid, value)}
              onAccept={() => {
                setFilterOpen(false);
                focusList();
              }}
              onClear={() => {
                setFilter(activeUid, "");
                setFilterOpen(false);
                focusList();
              }}
            />
          ) : null}
          <div className="min-h-0 flex-1">
            {list === undefined || (list.issues === null && list.error === null) ? (
              <EmptyState>Loading issues…</EmptyState>
            ) : list.issues === null ? (
              <EmptyState>
                <p>{list.error}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => activeUid && void loadList(rpc, activeUid)}
                >
                  Retry
                </Button>
              </EmptyState>
            ) : (
              <IssueList
                ref={listRef}
                rows={rows}
                selectedUid={selectedUid}
                focused={hasFocus && pane === "list"}
                draft={draftSlot}
                editing={editingSlot}
                isPending={(issue) => isPlaceholder(issue.uid)}
                linkedUid={linkedUid}
                onSelect={(uid) => {
                  select(uid);
                  if (narrow) {
                    setPane("detail");
                    requestAnimationFrame(() => detailRef.current?.focus({ preventScroll: true }));
                    return;
                  }
                  listRef.current?.focus({ preventScroll: true });
                }}
                onToggle={toggleRow}
                onFocus={() => setPane("list")}
                empty={
                  <EmptyState>
                    {filter !== "" ? (
                      "No issues match the filter."
                    ) : statusView === "closed" ? (
                      <>
                        No closed issues · <Kbd>s</Kbd>: show open
                      </>
                    ) : statusView === "all" ? (
                      <>
                        No issues yet · <Kbd>n</Kbd>: new issue
                      </>
                    ) : (
                      <>
                        No open issues · <Kbd>n</Kbd>: new issue · <Kbd>s</Kbd>: show closed
                      </>
                    )}
                  </EmptyState>
                }
              />
            )}
          </div>
          {labelIssue && activeUid ? (
            <LabelBar
              key={labelIssue.uid}
              issueLabel={labelIssue.short_id}
              current={labelIssue.labels ?? []}
              known={knownLabels}
              onCancel={() => {
                setLabelFor(null);
                focusList();
              }}
              onApply={(change) => {
                const projectUid = activeUid;
                setLabelFor(null);
                focusList();
                setLabels(rpc, projectUid, labelIssue.uid, change).catch((error: unknown) =>
                  flashError(`Labels on ${labelIssue.short_id} failed`, error),
                );
              }}
            />
          ) : null}
        </div>
        {splitWide ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the issue list"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={resetSplit}
            title="drag: resize · double-click: reset"
            className="group relative z-10 w-1 shrink-0 cursor-col-resize touch-none select-none"
          >
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-primary",
                detailFocused ? "bg-ring/50" : "bg-border",
                dragging && "bg-primary",
              )}
            />
          </div>
        ) : null}
        <div className={cn("min-h-0 min-w-0 flex-1 flex-col", narrow && pane !== "detail" ? "hidden" : "flex")}>
          {narrow ? (
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-xs text-muted-foreground">
              <button
                type="button"
                tabIndex={-1}
                aria-label="Back to the issue list"
                onMouseDown={(event) => event.preventDefault()}
                onClick={focusList}
                className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
              >
                ← Issues
              </button>
              <span>
                <Kbd>esc</Kbd> back
              </span>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
          <IssueDetail
            ref={detailRef}
            issue={selectedIssue}
            detail={detail}
            detailError={detailError}
            pendingComments={shownComments}
            onFocus={() => setPane("detail")}
            titleOf={titleOf}
            onOpenPeer={openPeer}
          />
          </div>
        </div>
      </div>
    );
  }

  const shownCount = list?.issues?.length ?? 0;
  const openInList = list?.issues?.filter((issue) => issue.status === "open").length ?? 0;
  const countText =
    statusView === "open"
      ? `${openInList} open`
      : statusView === "closed"
        ? `${shownCount - openInList} closed`
        : `${shownCount} issues, ${openInList} open`;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={() => {
        wantsFocus.current = true;
        setHasFocus(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (event.currentTarget.contains(next)) return;
        setHasFocus(false);
        // Focus went somewhere else on purpose (null: the window, or a removed element).
        if (next !== null) wantsFocus.current = false;
      }}
      className={cn(
        "relative flex h-full min-h-0 flex-1 flex-col outline-none",
        // While dragging, the cursor stays the handle's wherever the pointer goes.
        dragging && "cursor-col-resize select-none",
      )}
    >
      {scopedUid === null ? (
        <ProjectTabs
          included={tabs}
          visiting={visiting}
          projects={view.projects}
          activeUid={activeUid}
          counts={counts}
          statuses={view.status}
          onActivate={(uid) => {
            activate(uid);
            // The tab button took focus on mousedown (it must, for the drag).
            focusList();
          }}
          onOpenPicker={() => setPickerOpen(true)}
          onMove={(uid, slot) => {
            saveOrder(moveToSlot(included, uid, slot));
            focusList();
          }}
        />
      ) : null}
      {view.daemon.available ? null : (
        <div
          role="alert"
          title={view.daemon.message ?? undefined}
          className="flex shrink-0 items-center gap-2 border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" />
          <span className="min-w-0 truncate">
            kata daemon unreachable — retrying… Showing cached issues; edits are paused.
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-muted-foreground">
        <span
          className={cn("min-w-0 flex-1 truncate", hint?.tone === "error" && "text-destructive")}
          role={hint?.tone === "error" ? "alert" : undefined}
          aria-live="polite"
          title={hint?.text}
        >
          {hint?.text ?? ""}
        </span>
        {list?.issues ? (
          <span className="shrink-0">
            {filter !== "" ? `${rows.filter((row) => row.match).length} of ` : ""}
            {countText}
            {list.truncated ? " (truncated)" : ""}
            {narrow ? "" : ` · ${view.nested ? "nested" : "flat"}`}
          </span>
        ) : null}
        {statusView !== "open" && scopedUid !== null ? (
          <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide">
            {statusView}
          </span>
        ) : null}
        {list?.error && list.issues ? <span className="shrink-0 text-destructive">refresh failed</span> : null}
        {hasFocus ? (
          <span className="shrink-0">
            <Kbd>?</Kbd> help
          </span>
        ) : (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={focusList}
            className="shrink-0 rounded px-1 text-foreground underline decoration-dotted underline-offset-2 hover:bg-muted"
          >
            Click to use the keyboard
          </button>
        )}
      </div>
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
      {dialog?.kind === "close" ? (
        <CloseDialog
          issueLabel={dialog.label}
          {...(dialog.initial ? { initial: dialog.initial } : {})}
          error={dialog.error}
          onCancel={() => {
            setDialog(null);
            focusList();
          }}
          onSubmit={(values) => submitClose(dialog.issueUid, dialog.label, values)}
        />
      ) : null}
      {dialog?.kind === "body" ? (
        <BodyDialog
          key={dialog.issueUid}
          issueLabel={dialog.label}
          initial={dialog.initial}
          original={dialog.original}
          error={dialog.error}
          onCancel={() => {
            setDialog(null);
            focusList();
          }}
          onSubmit={(text) => submitBody(dialog.issueUid, dialog.label, dialog.original, text)}
        />
      ) : null}
      {dialog?.kind === "comment" ? (
        <CommentDialog
          issueLabel={dialog.label}
          {...(dialog.initial !== undefined ? { initial: dialog.initial } : {})}
          error={dialog.error}
          onCancel={() => {
            setDialog(null);
            focusList();
          }}
          onSubmit={(text) => submitComment(dialog.issueUid, dialog.label, text)}
        />
      ) : null}
      {scopedUid === null ? (
        <ProjectPicker
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open);
            if (!open) requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
          }}
          projects={view.projects}
          projectsError={view.projectsError}
          included={included}
          onChange={saveOrder}
        />
      ) : null}
    </div>
  );
}
