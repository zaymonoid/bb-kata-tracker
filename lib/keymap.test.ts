// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BINDING_GROUPS,
  handleKey,
  inputKey,
  pickerKey,
  initialKeymapState,
  pendingHint,
  type KeyCommand,
  type KeyContext,
  type KeyInput,
  type KeymapState,
  type Pane,
} from "./keymap.ts";

/** Feed keys in order; return every command emitted and the final state. */
function press(keys: Array<string | KeyInput>, pane: Pane = "list", context: KeyContext = {}) {
  let state: KeymapState = initialKeymapState;
  const commands: KeyCommand[] = [];
  const handled: boolean[] = [];
  for (const key of keys) {
    const result = handleKey(state, typeof key === "string" ? { key } : key, pane, context);
    state = result.state;
    handled.push(result.handled);
    if (result.command) commands.push(result.command);
  }
  return { state, commands, handled };
}

test("j/k and arrows move the list selection", () => {
  assert.deepEqual(press(["j", "ArrowDown", "k", "ArrowUp"]).commands, [
    { type: "move", delta: 1 },
    { type: "move", delta: 1 },
    { type: "move", delta: -1 },
    { type: "move", delta: -1 },
  ]);
});

test("j/k scroll the detail pane instead of moving the selection", () => {
  assert.deepEqual(press(["j", "k"], "detail").commands, [
    { type: "scrollDetail", delta: 1 },
    { type: "scrollDetail", delta: -1 },
  ]);
});

test("g g goes to the top, G to the bottom", () => {
  const { commands, state } = press(["g", "g", "G"]);
  assert.deepEqual(commands, [{ type: "top" }, { type: "bottom" }]);
  assert.equal(state.pending, null);
});

test("a lone g is pending with a hint", () => {
  const { state, handled } = press(["g"]);
  assert.equal(state.pending, "g");
  assert.deepEqual(handled, [true]);
  assert.equal(pendingHint(state), "g…");
});

test("g followed by another key runs that key on its own", () => {
  assert.deepEqual(press(["g", "j"]).commands, [{ type: "move", delta: 1 }]);
  assert.deepEqual(press(["g", "]"]).commands, [{ type: "tab", delta: 1 }]);
});

test("Shift while a chord is pending does not cancel it", () => {
  assert.deepEqual(press(["g", "Shift", "g"]).commands, [{ type: "top" }]);
  assert.deepEqual(press(["!", "Shift", "2"]).commands, [
    { type: "setPriority", priority: 2 },
  ]);
});

test("Enter focuses the detail; Esc returns to the list", () => {
  assert.deepEqual(press(["Enter"]).commands, [{ type: "focusDetail" }]);
  assert.deepEqual(press(["Escape"], "detail").commands, [{ type: "focusList" }]);
});

test("Esc in the list and Enter in the detail are left to the host", () => {
  assert.deepEqual(press(["Escape"]).handled, [false]);
  assert.deepEqual(press(["Enter"], "detail").handled, [false]);
});

test("[ and ] switch project tabs from either pane", () => {
  assert.deepEqual(press(["[", "]"], "detail").commands, [
    { type: "tab", delta: -1 },
    { type: "tab", delta: 1 },
  ]);
});

test("alt-[ / alt-] move the tab, by key or by code", () => {
  assert.deepEqual(press([{ key: "[", altKey: true }, { key: "]", altKey: true }]).commands, [
    { type: "moveTab", delta: -1 },
    { type: "moveTab", delta: 1 },
  ]);
  // macOS rewrites the key under Option; the physical code decides.
  assert.deepEqual(press([{ key: "“", code: "BracketLeft", altKey: true }]).commands, [
    { type: "moveTab", delta: -1 },
  ]);
  assert.deepEqual(press([{ key: "‘", code: "BracketRight", altKey: true }]).commands, [
    { type: "moveTab", delta: 1 },
  ]);
  // Plain brackets still switch tabs, and other Alt keys stay with the host.
  assert.deepEqual(press(["[", "]"]).commands, [{ type: "tab", delta: -1 }, { type: "tab", delta: 1 }]);
  assert.deepEqual(press([{ key: "[", altKey: true, metaKey: true }, { key: "j", altKey: true }]).handled, [
    false,
    false,
  ]);
  // Not while typing, and a pending chord is dropped.
  assert.deepEqual(press([{ key: "]", altKey: true }], "list", { typing: true }).commands, []);
  assert.equal(press(["g", { key: "]", altKey: true }]).state.pending, null);
});

test("cmd-[ / cmd-] switch group, by code", () => {
  assert.deepEqual(
    press([
      { key: "[", code: "BracketLeft", metaKey: true },
      { key: "]", code: "BracketRight", metaKey: true },
    ]).commands,
    [
      { type: "group", delta: -1 },
      { type: "group", delta: 1 },
    ],
  );
  assert.deepEqual(press([{ key: "]", code: "BracketRight", metaKey: true }], "detail").commands, [
    { type: "group", delta: 1 },
  ]);
  // With Ctrl or Alt as well, or another Meta key, it stays with the host.
  assert.deepEqual(
    press([
      { key: "[", code: "BracketLeft", metaKey: true, ctrlKey: true },
      { key: "“", code: "BracketLeft", metaKey: true, altKey: true },
      { key: "j", code: "KeyJ", metaKey: true },
    ]).handled,
    [false, false, false],
  );
  // Not while typing, and a pending chord is dropped.
  assert.deepEqual(press([{ key: "]", code: "BracketRight", metaKey: true }], "list", { typing: true }).commands, []);
  assert.equal(press(["g", { key: "]", code: "BracketRight", metaKey: true }]).state.pending, null);
});

test("? toggles help", () => {
  assert.deepEqual(press(["?"]).commands, [{ type: "help" }]);
});

test("! then a digit sets priority; ! - clears it", () => {
  assert.deepEqual(press(["!", "1"]).commands, [{ type: "setPriority", priority: 1 }]);
  assert.deepEqual(press(["!", "0"]).commands, [{ type: "setPriority", priority: 0 }]);
  assert.deepEqual(press(["!", "-"]).commands, [{ type: "setPriority", priority: null }]);
  assert.deepEqual(press(["!", "Backspace"]).commands, [{ type: "setPriority", priority: null }]);
  assert.deepEqual(press(["!", "4"]).commands, [{ type: "setPriority", priority: 4 }]);
  assert.match(pendingHint(press(["!"]).state) ?? "", /^priority…/u);
});

test("! followed by anything else is cancelled and swallowed", () => {
  const { commands, state, handled } = press(["!", "j"]);
  assert.deepEqual(commands, []);
  assert.equal(state.pending, null);
  assert.deepEqual(handled, [true, true]);
  assert.deepEqual(press(["!", "9"]).commands, []);
});

test("other modified keys are not claimed and reset a pending chord", () => {
  const result = press(["g", { key: "g", metaKey: true }]);
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.handled, [true, false]);
  assert.equal(result.state.pending, null);
  assert.deepEqual(press([{ key: "k", ctrlKey: true }]).handled, [false]);
});

test("edit keys map to their commands", () => {
  assert.deepEqual(
    press(["n", "N", "x", "r", "c", "l", "e", "b", "s", "y", "/", "v", "E"]).commands.map((c) => c.type),
    ["newIssue", "newChild", "close", "reopen", "comment", "label", "editTitle", "editBody", "cycleStatus", "copyRef", "search", "toggleView", "toggleAll"],
  );
});

test("Esc cancels a pending priority chord without running anything", () => {
  const { commands, state, handled } = press(["!", "Escape", "j"]);
  assert.deepEqual(commands, [{ type: "move", delta: 1 }]);
  assert.equal(state.pending, null);
  assert.deepEqual(handled, [true, true, true]);
});

test("! chord then n starts nothing (the chord swallows the key)", () => {
  assert.deepEqual(press(["!", "n"]).commands, []);
});

test("Space toggles, arrows expand and collapse, only in the list", () => {
  assert.deepEqual(press([" ", "ArrowRight", "ArrowLeft"]).commands, [
    { type: "toggle" },
    { type: "expand" },
    { type: "collapse" },
  ]);
  assert.deepEqual(press([" ", "ArrowRight", "ArrowLeft"], "detail").handled, [false, false, false]);
});

test("Esc in the list clears an active filter, otherwise is left to the host", () => {
  assert.deepEqual(press(["Escape"], "list", { filterActive: true }).commands, [{ type: "clearFilter" }]);
  assert.deepEqual(press(["Escape"], "list", { filterActive: false }).handled, [false]);
});

test("nothing fires while a text field has focus", () => {
  const typed = press(["n", "!", "1", "j", "x", "Escape", "Enter", "?"], "list", { typing: true });
  assert.deepEqual(typed.commands, []);
  assert.ok(typed.handled.every((h) => !h));
  assert.equal(typed.state.pending, null);
});

test("typing into a field drops a chord that was pending", () => {
  let state: KeymapState = handleKey(initialKeymapState, { key: "!" }, "list").state;
  state = handleKey(state, { key: "1" }, "list", { typing: true }).state;
  assert.equal(state.pending, null);
});

test("text fields hand over only Esc and the save chords", () => {
  assert.equal(inputKey({ key: "Escape" }, "line"), "cancel");
  assert.equal(inputKey({ key: "Escape" }, "multiline"), "cancel");
  assert.equal(inputKey({ key: "Enter" }, "line"), "submit");
  assert.equal(inputKey({ key: "Enter", shiftKey: true }, "line"), "openBody");
  assert.equal(inputKey({ key: "Enter" }, "multiline"), null);
  assert.equal(inputKey({ key: "Enter", shiftKey: true }, "multiline"), null);
  assert.equal(inputKey({ key: "Enter", metaKey: true }, "multiline"), "submit");
  assert.equal(inputKey({ key: "Enter", ctrlKey: true }, "line"), "submit");
  assert.equal(inputKey({ key: "o", ctrlKey: true }, "multiline"), "saveDraft");
  assert.equal(inputKey({ key: "o", ctrlKey: true }, "line"), "saveDraft");
  for (const key of ["n", "j", "!", "1", "x", "?", "/", " ", "o", "Backspace", "ArrowLeft"]) {
    assert.equal(inputKey({ key }, "line"), null, key);
    assert.equal(inputKey({ key }, "multiline"), null, key);
  }
  assert.equal(inputKey({ key: "o", metaKey: true }, "line"), null);
});

test("help lists nothing as coming soon", () => {
  for (const group of BINDING_GROUPS) {
    assert.doesNotMatch(group.title, /soon/iu);
    for (const binding of group.bindings) assert.doesNotMatch(binding.label, /soon/iu);
  }
});

test("unbound keys are not handled", () => {
  assert.deepEqual(press(["z", "Tab"]).handled, [false, false]);
});

test("L links the selection to the thread", () => {
  assert.deepEqual(handleKey(initialKeymapState, { key: "L" }, "list").command, { type: "linkThread" });
  assert.equal(handleKey(initialKeymapState, { key: "l" }, "list").command?.type, "label");
});

test("help groups follow navigate / tabs / picker / create & edit / view", () => {
  assert.deepEqual(
    BINDING_GROUPS.map((group) => group.title),
    ["Navigate", "Tabs", "Project picker (gear)", "Create & edit", "View", "In text fields"],
  );
});

// The overlay keys each row by its label, so they must not repeat in a group.
test("labels are unique inside a group", () => {
  for (const group of BINDING_GROUPS) {
    const labels = group.bindings.map((binding) => binding.label);
    assert.equal(new Set(labels).size, labels.length, group.title);
  }
});

test("every single key the list claims is in the help", () => {
  const listed = new Set(
    BINDING_GROUPS.slice(0, -1).flatMap((group) => group.bindings.flatMap((binding) => binding.keys)),
  );
  const shown: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", ArrowRight: "→", ArrowLeft: "←", " ": "space", PageDown: "pgdn", PageUp: "pgup", Escape: "esc", Home: "home", End: "end", Enter: "enter" };
  const keys = [..."abcdefhijklmnopqrstuvwxyzABCDEFHIJKLMNOPQRSTUVWXYZ[]?/", ...Object.keys(shown), "Home", "End", "Enter", "G"];
  for (const key of keys) {
    const result = handleKey(initialKeymapState, { key }, "list", { filterActive: true });
    if (!result.handled || result.state.pending !== null) continue;
    assert.ok(listed.has(shown[key] ?? key), `${JSON.stringify(key)} is bound but not in the help`);
  }
});

// ---- the project picker ------------------------------------------------------

const idlePicker = { typing: false, confirming: false };

test("picker: j / k and arrows move, space toggles", () => {
  assert.deepEqual(pickerKey({ key: "j" }, idlePicker), { type: "cursor", delta: 1 });
  assert.deepEqual(pickerKey({ key: "ArrowDown" }, idlePicker), { type: "cursor", delta: 1 });
  assert.deepEqual(pickerKey({ key: "k" }, idlePicker), { type: "cursor", delta: -1 });
  assert.deepEqual(pickerKey({ key: "ArrowUp" }, idlePicker), { type: "cursor", delta: -1 });
  assert.deepEqual(pickerKey({ key: " " }, idlePicker), { type: "toggle" });
});

test("picker: alt-j / alt-k and alt-arrows move the row, by code under Option", () => {
  assert.deepEqual(pickerKey({ key: "∆", code: "KeyJ", altKey: true }, idlePicker), { type: "shift", delta: 1 });
  assert.deepEqual(pickerKey({ key: "˚", code: "KeyK", altKey: true }, idlePicker), { type: "shift", delta: -1 });
  assert.deepEqual(pickerKey({ key: "ArrowDown", altKey: true }, idlePicker), { type: "shift", delta: 1 });
  assert.deepEqual(pickerKey({ key: "ArrowUp", altKey: true }, idlePicker), { type: "shift", delta: -1 });
  assert.equal(pickerKey({ key: "j", code: "KeyJ", altKey: true, metaKey: true }, idlePicker), null);
});

test("picker: cmd-[ / cmd-] switch group; n, e, d manage it", () => {
  assert.deepEqual(pickerKey({ key: "[", code: "BracketLeft", metaKey: true }, idlePicker), { type: "group", delta: -1 });
  assert.deepEqual(pickerKey({ key: "]", code: "BracketRight", metaKey: true }, idlePicker), { type: "group", delta: 1 });
  assert.deepEqual(pickerKey({ key: "n" }, idlePicker), { type: "newGroup" });
  assert.deepEqual(pickerKey({ key: "e" }, idlePicker), { type: "renameGroup" });
  assert.deepEqual(pickerKey({ key: "d" }, idlePicker), { type: "deleteGroup" });
  // Other keys, and other modified keys, are left alone.
  for (const input of [{ key: "x" }, { key: "Escape" }, { key: "Enter" }, { key: "j", ctrlKey: true }, { key: "n", metaKey: true }]) {
    assert.equal(pickerKey(input, idlePicker), null, input.key);
  }
});

test("picker: nothing fires while a name input has focus", () => {
  const typing = { typing: true, confirming: false };
  for (const input of [{ key: "j" }, { key: " " }, { key: "n" }, { key: "Enter" }, { key: "]", code: "BracketRight", metaKey: true }]) {
    assert.equal(pickerKey(input, typing), null, input.key);
  }
});

test("picker: a pending delete takes Enter to confirm and any other key to cancel", () => {
  const confirming = { typing: false, confirming: true };
  assert.deepEqual(pickerKey({ key: "Enter" }, confirming), { type: "confirmDelete" });
  assert.deepEqual(pickerKey({ key: "j" }, confirming), { type: "cancelDelete" });
  assert.deepEqual(pickerKey({ key: "Enter", metaKey: true }, confirming), { type: "cancelDelete" });
  // Esc is the dialog's; a bare modifier press is no answer.
  assert.equal(pickerKey({ key: "Escape" }, confirming), null);
  assert.equal(pickerKey({ key: "Shift" }, confirming), null);
});

test("every key the picker claims is in its help group", () => {
  const picker = BINDING_GROUPS.find((group) => group.title === "Project picker (gear)")!;
  const listed = new Set(picker.bindings.flatMap((binding) => binding.keys));
  const shown: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", " ": "space", Escape: "esc" };
  const name = (input: KeyInput) =>
    `${input.metaKey ? "⌘" : input.altKey ? "alt-" : ""}${shown[input.key] ?? input.key}`;
  const inputs: KeyInput[] = [
    ...[..."abcdefghijklmnopqrstuvwxyz[]", ...Object.keys(shown)].map((key) => ({ key })),
    { key: "[", code: "BracketLeft", metaKey: true },
    { key: "]", code: "BracketRight", metaKey: true },
    { key: "j", altKey: true },
    { key: "k", altKey: true },
    { key: "ArrowDown", altKey: true },
    { key: "ArrowUp", altKey: true },
  ];
  let claimed = 0;
  for (const input of inputs) {
    if (pickerKey(input, idlePicker) === null) continue;
    claimed += 1;
    assert.ok(listed.has(name(input)), `${name(input)} is bound in the picker but not in its help`);
  }
  // j k n e d, ↓ ↑ space, ⌘[ ⌘], alt-j alt-k alt-↓ alt-↑
  assert.equal(claimed, 14);
});
