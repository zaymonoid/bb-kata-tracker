// The Kata panel's keyboard map: a pure state machine from key presses to
// commands, so chords (`g g`, `! 1`) are testable without a DOM.
//
// The panel feeds it keydown events while it has focus and runs the returned
// command. Keys with Ctrl/Meta/Alt are never claimed, so host shortcuts keep
// working. While a text field has focus, `handleKey` claims nothing; the
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
  | { type: "help" }
  | { type: "clearFilter" }
  | { type: "newIssue" }
  | { type: "newChild" }
  | { type: "setPriority"; priority: number | null }
  | { type: "close" }
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
 * `alt-[` / `alt-]`: move the current tab. The only modified keys the panel
 * claims. macOS turns Option+[ into `“`, so the physical `code` decides
 * when the caller reports one.
 */
function moveTabKey(input: KeyInput): 1 | -1 | null {
  if (input.altKey !== true || input.ctrlKey === true || input.metaKey === true) return null;
  if (input.code === "BracketLeft" || input.key === "[") return -1;
  if (input.code === "BracketRight" || input.key === "]") return 1;
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
      { keys: ["["], label: "prev tab" },
      { keys: ["]"], label: "next tab" },
      { keys: ["alt-["], label: "move tab left" },
      { keys: ["alt-]"], label: "move tab right" },
      { keys: ["?"], label: "help" },
    ],
  },
  {
    title: "Create",
    bindings: [
      { keys: ["n"], label: "new issue" },
      { keys: ["N"], label: "new child" },
    ],
  },
  {
    title: "Edit",
    bindings: [
      { keys: ["! 0…4"], label: "priority P0–P4" },
      { keys: ["! -", "! ⌫"], label: "clear priority" },
      { keys: ["e"], label: "edit title" },
      { keys: ["b"], label: "edit body" },
      { keys: ["x"], label: "close" },
      { keys: ["r"], label: "reopen" },
      { keys: ["c"], label: "comment" },
      { keys: ["l"], label: "labels (-name removes)" },
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
    ],
  },
  {
    title: "Thread",
    bindings: [{ keys: ["L"], label: "link to thread" }],
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
