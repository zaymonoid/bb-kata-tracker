// The Kata panel's keyboard map: a pure state machine from key presses to
// commands, so chords (`g g`, `! 1`) are testable without a DOM.
//
// The panel feeds it keydown events while it has focus and runs the returned
// command. Keys with Ctrl/Meta/Alt are not claimed, so host shortcuts keep
// working; the exceptions are `alt-[` / `alt-]` and `cmd-[` / `cmd-]`. While a text field has focus, `handleKey` claims nothing; the
// field asks `inputKey` instead, which only knows Esc and the save chords.

export type Pane = "list" | "detail";

export type KeyCommand =
  | { type: "move"; delta: number }
  | { type: "page"; direction: 1 | -1 }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "focusDetail" }
  | { type: "focusList" }
  | { type: "scrollDetail"; delta: number }
  | { type: "tab"; delta: 1 | -1 }
  | { type: "moveTab"; delta: 1 | -1 }
  | { type: "group"; delta: 1 | -1 }
  | { type: "help" }
  | { type: "clearFilter" }
  | { type: "newIssue" }
  | { type: "newChild" }
  | { type: "setPriority"; priority: number | null }
  | { type: "close" }
  | { type: "closeDone" }
  | { type: "reopen" }
  | { type: "comment" }
  | { type: "label" }
  | { type: "editTitle" }
  | { type: "editBody" }
  | { type: "cycleStatus" }
  | { type: "copyRef" }
  | { type: "linkThread" }
  | { type: "search" }
  | { type: "toggleView" }
  | { type: "expand" }
  | { type: "toggle" }
  | { type: "collapse" }
  | { type: "toggleAll" };

export interface KeymapState {
  /** First key of an unfinished chord, or null. */
  pending: "g" | "!" | null;
}

export const initialKeymapState: KeymapState = { pending: null };

/** A pending chord is abandoned after this long without a second key. */
export const CHORD_TIMEOUT_MS = 1500;

export interface KeyInput {
  key: string;
  /** Physical key, when the caller has one: Alt rewrites `key` on macOS. */
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface KeyResult {
  state: KeymapState;
  command: KeyCommand | null;
  /** The key was consumed (the caller should preventDefault). */
  handled: boolean;
}

/** Human hint while a chord is pending. */
export function pendingHint(state: KeymapState): string | null {
  switch (state.pending) {
    case "g":
      return "g…";
    case "!":
      return "priority… 0–4 to set, - to clear, esc to cancel";
    default:
      return null;
  }
}

const idle = (command: KeyCommand | null, handled = command !== null): KeyResult => ({
  state: initialKeymapState,
  command,
  handled,
});

/**
 * `alt-[` / `alt-]`: move the current tab. With `groupKey`, the only modified
 * keys the panel claims. macOS turns Option+[ into `“`, so the physical `code` decides
 * when the caller reports one.
 */
function moveTabKey(input: KeyInput): 1 | -1 | null {
  if (input.altKey !== true || input.ctrlKey === true || input.metaKey === true) return null;
  if (input.code === "BracketLeft" || input.key === "[") return -1;
  if (input.code === "BracketRight" || input.key === "]") return 1;
  return null;
}

/**
 * `cmd-[` / `cmd-]`: switch to the previous / next group. Detected by the
 * physical `code`, as for `alt-[` / `alt-]`, so a remapped `key` cannot miss.
 */
function groupKey(input: KeyInput): 1 | -1 | null {
  if (input.metaKey !== true || input.ctrlKey === true || input.altKey === true) return null;
  if (input.code === "BracketLeft") return -1;
  if (input.code === "BracketRight") return 1;
  return null;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Meta", "Alt", "CapsLock"]);

export interface KeyContext {
  /** A text field has focus: leave every key to it (see `inputKey`). */
  typing?: boolean;
  /** The list is filtered, so Esc in the list clears the filter. */
  filterActive?: boolean;
}

export function handleKey(
  state: KeymapState,
  input: KeyInput,
  pane: Pane,
  context: KeyContext = {},
): KeyResult {
  if (context.typing) return { state: initialKeymapState, command: null, handled: false };
  const moveTab = moveTabKey(input);
  if (moveTab !== null) return idle({ type: "moveTab", delta: moveTab });
  const group = groupKey(input);
  if (group !== null) return idle({ type: "group", delta: group });
  if (input.ctrlKey || input.metaKey || input.altKey) {
    return { state: initialKeymapState, command: null, handled: false };
  }
  const { key } = input;
  // A bare modifier press (e.g. Shift on the way to `!` or `G`) changes nothing.
  if (MODIFIER_KEYS.has(key)) return { state, command: null, handled: false };

  if (state.pending === "!") {
    if (/^[0-4]$/u.test(key)) return idle({ type: "setPriority", priority: Number(key) });
    if (key === "-" || key === "Backspace") return idle({ type: "setPriority", priority: null });
    // Anything else cancels; swallow it so a mistyped chord does nothing.
    return idle(null, true);
  }
  if (state.pending === "g") {
    if (key === "g") return idle({ type: "top" });
    // Not a chord after all: handle the key on its own.
    return handleKey(initialKeymapState, input, pane, context);
  }

  switch (key) {
    case "g":
      return { state: { pending: "g" }, command: null, handled: true };
    case "!":
      return { state: { pending: "!" }, command: null, handled: true };
    case "G":
      return idle({ type: "bottom" });
    case "j":
    case "ArrowDown":
      return idle(pane === "list" ? { type: "move", delta: 1 } : { type: "scrollDetail", delta: 1 });
    case "k":
    case "ArrowUp":
      return idle(pane === "list" ? { type: "move", delta: -1 } : { type: "scrollDetail", delta: -1 });
    case "PageDown":
      return idle({ type: "page", direction: 1 });
    case "PageUp":
      return idle({ type: "page", direction: -1 });
    case "Home":
      return idle({ type: "top" });
    case "End":
      return idle({ type: "bottom" });
    case "Enter":
      return pane === "list" ? idle({ type: "focusDetail" }) : idle(null, false);
    case "Escape":
      if (pane === "detail") return idle({ type: "focusList" });
      return context.filterActive ? idle({ type: "clearFilter" }) : idle(null, false);
    case "[":
      return idle({ type: "tab", delta: -1 });
    case "]":
      return idle({ type: "tab", delta: 1 });
    case "?":
      return idle({ type: "help" });
    case "n":
      return idle({ type: "newIssue" });
    case "N":
      return idle({ type: "newChild" });
    case "x":
      return idle({ type: "close" });
    case "X":
      return idle({ type: "closeDone" });
    case "r":
      return idle({ type: "reopen" });
    case "c":
      return idle({ type: "comment" });
    case "l":
      return idle({ type: "label" });
    case "e":
      return idle({ type: "editTitle" });
    case "b":
      return idle({ type: "editBody" });
    case "s":
      return idle({ type: "cycleStatus" });
    case "y":
      return idle({ type: "copyRef" });
    case "L":
      return idle({ type: "linkThread" });
    case "/":
      return idle({ type: "search" });
    case "v":
      return idle({ type: "toggleView" });
    case " ":
      return pane === "list" ? idle({ type: "toggle" }) : idle(null, false);
    case "ArrowRight":
      return pane === "list" ? idle({ type: "expand" }) : idle(null, false);
    case "ArrowLeft":
      return pane === "list" ? idle({ type: "collapse" }) : idle(null, false);
    case "E":
      return idle({ type: "toggleAll" });
  }
  return idle(null, false);
}

// ---- text fields ----------------------------------------------------------

/** `line`: a one-line input (title, label, filter). `multiline`: a textarea. */
export type FieldKind = "line" | "multiline";

export type InputCommand =
  /** Enter in a line field, or Cmd/Ctrl+Enter anywhere. */
  | "submit"
  /** Ctrl-O: save the draft (the new-issue title first reveals its body). */
  | "saveDraft"
  /** Shift+Enter in a line field: open a body field. */
  | "openBody"
  | "cancel";

/**
 * The only keys a focused text field hands to the panel. Everything else
 * (null) is ordinary typing and must reach the field untouched.
 */
export function inputKey(input: KeyInput & { shiftKey?: boolean }, field: FieldKind): InputCommand | null {
  const { key } = input;
  if (key === "Escape" && !input.ctrlKey && !input.metaKey && !input.altKey) return "cancel";
  if (key === "Enter" && (input.metaKey || input.ctrlKey)) return "submit";
  if ((key === "o" || key === "O") && input.ctrlKey && !input.metaKey && !input.altKey) return "saveDraft";
  if (key === "Enter" && field === "line" && !input.altKey) return input.shiftKey ? "openBody" : "submit";
  return null;
}

// ---- the project picker -----------------------------------------------------

export type PickerCommand =
  /** Move the highlighted row. */
  | { type: "cursor"; delta: 1 | -1 }
  /** Check or uncheck the highlighted row (in or out of the group being edited). */
  | { type: "toggle" }
  /** Move the highlighted checked row up or down within the group. */
  | { type: "shift"; delta: 1 | -1 }
  /** Edit the previous / next group (it becomes the active group). */
  | { type: "group"; delta: 1 | -1 }
  | { type: "newGroup" }
  | { type: "renameGroup" }
  /** Ask to delete the group being edited (a confirm step follows). */
  | { type: "deleteGroup" }
  | { type: "confirmDelete" }
  | { type: "cancelDelete" };

export interface PickerContext {
  /** An inline name input has focus: it handles Enter / Esc itself. */
  typing: boolean;
  /** A delete is waiting for Enter (confirm) or any other key (cancel). */
  confirming: boolean;
}

/** Alt+j / Alt+k / Alt+↓ / Alt+↑. macOS rewrites `key` under Option, so `code` decides. */
function pickerShiftKey(input: KeyInput): 1 | -1 | null {
  if (input.altKey !== true || input.ctrlKey === true || input.metaKey === true) return null;
  if (input.code === "KeyJ" || input.key === "ArrowDown" || input.key === "j") return 1;
  if (input.code === "KeyK" || input.key === "ArrowUp" || input.key === "k") return -1;
  return null;
}

/**
 * Keys of the project picker dialog (the gear in the tab strip). Esc is not here: the
 * dialog closes on it, after cancelling an inline input or a pending delete.
 * Null means the key is not the picker's and should be left alone.
 */
export function pickerKey(input: KeyInput, context: PickerContext): PickerCommand | null {
  if (context.typing || MODIFIER_KEYS.has(input.key)) return null;
  if (context.confirming) {
    if (input.key === "Escape") return null;
    const plain = !input.ctrlKey && !input.metaKey && !input.altKey;
    return plain && input.key === "Enter" ? { type: "confirmDelete" } : { type: "cancelDelete" };
  }
  const group = groupKey(input);
  if (group !== null) return { type: "group", delta: group };
  const shift = pickerShiftKey(input);
  if (shift !== null) return { type: "shift", delta: shift };
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  switch (input.key) {
    case "j":
    case "ArrowDown":
      return { type: "cursor", delta: 1 };
    case "k":
    case "ArrowUp":
      return { type: "cursor", delta: -1 };
    case " ":
      return { type: "toggle" };
    case "n":
      return { type: "newGroup" };
    case "e":
      return { type: "renameGroup" };
    case "d":
      return { type: "deleteGroup" };
    default:
      return null;
  }
}

export interface Binding {
  keys: readonly string[];
  label: string;
}

export interface BindingGroup {
  title: string;
  bindings: readonly Binding[];
}

/** What the `?` overlay lists (and the README's keymap table). */
export const BINDING_GROUPS: readonly BindingGroup[] = [
  {
    title: "Navigate",
    bindings: [
      { keys: ["j", "↓"], label: "next issue" },
      { keys: ["k", "↑"], label: "previous issue" },
      { keys: ["g g", "home"], label: "first issue" },
      { keys: ["G", "end"], label: "last issue" },
      { keys: ["pgdn"], label: "page down" },
      { keys: ["pgup"], label: "page up" },
      { keys: ["enter"], label: "open detail" },
      { keys: ["esc"], label: "back / clear filter" },
    ],
  },
  {
    title: "Tabs",
    bindings: [
      { keys: ["["], label: "prev tab" },
      { keys: ["]"], label: "next tab" },
      { keys: ["alt-["], label: "move tab left" },
      { keys: ["alt-]"], label: "move tab right" },
      { keys: ["⌘["], label: "prev group" },
      { keys: ["⌘]"], label: "next group" },
    ],
  },
  {
    title: "Project picker (gear)",
    bindings: [
      { keys: ["j", "↓"], label: "next project" },
      { keys: ["k", "↑"], label: "previous project" },
      { keys: ["space"], label: "add to / remove from group" },
      { keys: ["alt-j", "alt-↓"], label: "move project down" },
      { keys: ["alt-k", "alt-↑"], label: "move project up" },
      { keys: ["⌘["], label: "prev group" },
      { keys: ["⌘]"], label: "next group" },
      { keys: ["n"], label: "new group" },
      { keys: ["e"], label: "rename group" },
      { keys: ["d"], label: "delete group (enter confirms)" },
      { keys: ["esc"], label: "cancel / close" },
    ],
  },
  {
    title: "Create & edit",
    bindings: [
      { keys: ["n"], label: "new issue" },
      { keys: ["N"], label: "new child" },
      { keys: ["! 0…4"], label: "priority P0–P4" },
      { keys: ["! -", "! ⌫"], label: "clear priority" },
      { keys: ["e"], label: "edit title" },
      { keys: ["b"], label: "edit body" },
      { keys: ["l"], label: "labels (-name removes)" },
      { keys: ["c"], label: "comment" },
      { keys: ["x"], label: "close" },
      { keys: ["X"], label: "close as done" },
      { keys: ["r"], label: "reopen" },
      { keys: ["L"], label: "link to thread" },
    ],
  },
  {
    title: "View",
    bindings: [
      { keys: ["s"], label: "cycle open/all/closed" },
      { keys: ["/"], label: "filter" },
      { keys: ["v"], label: "nested/flat" },
      { keys: ["space"], label: "expand/collapse" },
      { keys: ["→"], label: "expand" },
      { keys: ["←"], label: "collapse / parent" },
      { keys: ["E"], label: "expand/collapse all" },
      { keys: ["y"], label: "copy project#id" },
      { keys: ["?"], label: "help" },
    ],
  },
  {
    title: "In text fields",
    bindings: [
      { keys: ["enter"], label: "save (one-line)" },
      { keys: ["⇧enter", "ctrl-o"], label: "add body" },
      { keys: ["ctrl-o", "⌘enter"], label: "save" },
      { keys: ["esc"], label: "cancel (twice if non-empty)" },
    ],
  },
];
