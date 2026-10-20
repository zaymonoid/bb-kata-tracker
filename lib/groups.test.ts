// Run with `npm test` (node --test, type-stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activateGroup,
  activeProjectUids,
  addGroup,
  findGroups,
  groupsFromIncluded,
  groupsOf,
  isUnsetGroups,
  newGroupId,
  normalizeGroups,
  rememberTab,
  removeGroup,
  renameGroup,
  serializeGroups,
  setGroupProjects,
  shiftGroup,
  stepGroup,
  tabOnSwitch,
  toggleGroupProject,
  withActiveProjects,
} from "./groups.ts";
import { isValidGroupsSetting, parseGroups } from "./groups-schema.ts";

const fixedId = () => "g0";

test("normalize drops duplicate group ids and dedupes projects within a group", () => {
  const value = normalizeGroups({
    groups: [
      { id: "a", name: "One", projectUids: ["P1", "P2", "P1"] },
      { id: "a", name: "Dup", projectUids: ["P3"] },
      { id: "b", name: "Two", projectUids: ["P2"] },
    ],
    activeGroupId: "b",
  });
  assert.deepEqual(value, {
    groups: [
      { id: "a", name: "One", projectUids: ["P1", "P2"] },
      { id: "b", name: "Two", projectUids: ["P2"] },
    ],
    activeGroupId: "b",
  });
});

test("an unknown active group falls back to the first", () => {
  const value = normalizeGroups({ groups: [{ id: "a", name: "One", projectUids: [] }], activeGroupId: "zz" });
  assert.equal(value.activeGroupId, "a");
});

test("zero groups become one empty Projects group", () => {
  assert.deepEqual(normalizeGroups({ groups: [], activeGroupId: "" }, fixedId), {
    groups: [{ id: "g0", name: "Projects", projectUids: [] }],
    activeGroupId: "g0",
  });
});

test("parse reads empty or invalid values as one empty group", () => {
  const empty = { groups: [{ id: "g0", name: "Projects", projectUids: [] }], activeGroupId: "g0" };
  assert.deepEqual(parseGroups("", fixedId), empty);
  assert.deepEqual(parseGroups("{nope", fixedId), empty);
  assert.deepEqual(parseGroups('{"groups":[{"id":"a"}],"activeGroupId":"a"}', fixedId), empty);
});

test("parse round-trips a serialized value", () => {
  const value = { groups: [{ id: "a", name: "One", projectUids: ["P1"] }], activeGroupId: "a" };
  assert.deepEqual(parseGroups(serializeGroups(value)), value);
});

test("setting validation accepts empty and valid JSON only", () => {
  assert.equal(isUnsetGroups("  "), true);
  assert.equal(isValidGroupsSetting(""), true);
  assert.equal(isValidGroupsSetting('{"groups":[],"activeGroupId":""}'), true);
  assert.equal(isValidGroupsSetting("[]"), false);
  assert.equal(isValidGroupsSetting('{"groups":[{"id":"a","name":" ","projectUids":[]}],"activeGroupId":"a"}'), false);
});

test("migration makes one active Projects group from includedProjects", () => {
  const value = groupsFromIncluded(["P1", "P2", "P1"], fixedId);
  assert.deepEqual(value, { groups: [{ id: "g0", name: "Projects", projectUids: ["P1", "P2"] }], activeGroupId: "g0" });
  assert.deepEqual(activeProjectUids(value), ["P1", "P2"]);
});

test("withActiveProjects replaces only the active group's projects", () => {
  const value = {
    groups: [
      { id: "a", name: "One", projectUids: ["P1"] },
      { id: "b", name: "Two", projectUids: ["P1", "P2"] },
    ],
    activeGroupId: "b",
  };
  const next = withActiveProjects(value, ["P3", "P3", "P1"]);
  assert.deepEqual(next.groups, [
    { id: "a", name: "One", projectUids: ["P1"] },
    { id: "b", name: "Two", projectUids: ["P3", "P1"] },
  ]);
  assert.deepEqual(activeProjectUids(next), ["P3", "P1"]);
});

test("group ids are short and differ", () => {
  const ids = new Set(Array.from({ length: 50 }, newGroupId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[a-z0-9]{6,12}$/u);
});

// ---- edits -------------------------------------------------------------------

const three = {
  groups: [
    { id: "w", name: "Work", projectUids: ["P1", "P2"] },
    { id: "p", name: "Personal", projectUids: ["P1"] },
    { id: "x", name: "Other", projectUids: [] },
  ],
  activeGroupId: "p",
};

test("activateGroup makes a known group active, else changes nothing", () => {
  assert.equal(activateGroup(three, "w").activeGroupId, "w");
  assert.equal(activateGroup(three, "p"), three);
  assert.equal(activateGroup(three, "nope"), three);
});

test("stepGroup wraps both ways and needs two groups", () => {
  assert.equal(stepGroup(three, 1).activeGroupId, "x");
  assert.equal(stepGroup(three, -1).activeGroupId, "w");
  assert.equal(stepGroup({ ...three, activeGroupId: "x" }, 1).activeGroupId, "w");
  assert.equal(stepGroup({ ...three, activeGroupId: "w" }, -1).activeGroupId, "x");
  const one = { groups: [three.groups[0]!], activeGroupId: "w" };
  assert.equal(stepGroup(one, 1), one);
});

test("addGroup appends an empty, active group with a trimmed name", () => {
  const next = addGroup(three, "  New  ", "n");
  assert.deepEqual(next.groups.at(-1), { id: "n", name: "New", projectUids: [] });
  assert.equal(next.activeGroupId, "n");
  assert.deepEqual(next.groups.slice(0, 3), three.groups);
  assert.equal(addGroup(three, "   ", "n"), three);
  assert.equal(addGroup(three, "Dup", "w"), three);
  assert.equal(addGroup(three, "x".repeat(150), "n").groups.at(-1)?.name.length, 100);
});

test("renameGroup trims, and a blank or same name changes nothing", () => {
  assert.equal(renameGroup(three, "w", " Job ").groups[0]?.name, "Job");
  assert.equal(renameGroup(three, "w", " "), three);
  assert.equal(renameGroup(three, "w", "Work"), three);
  assert.equal(renameGroup(three, "nope", "Job"), three);
});

test("removeGroup activates the previous group and keeps projects elsewhere", () => {
  const next = removeGroup(three, "p");
  assert.deepEqual(next.groups.map((group) => group.id), ["w", "x"]);
  assert.equal(next.activeGroupId, "w");
  assert.deepEqual(groupsOf(next, "P1").map((group) => group.id), ["w"]);
  // The first group, when active, hands over to the next one.
  assert.equal(removeGroup({ ...three, activeGroupId: "w" }, "w").activeGroupId, "p");
  // Removing an inactive group keeps the active one.
  assert.equal(removeGroup(three, "x").activeGroupId, "p");
});

test("removeGroup never removes the last group", () => {
  const one = { groups: [three.groups[0]!], activeGroupId: "w" };
  assert.equal(removeGroup(one, "w"), one);
  assert.equal(removeGroup(three, "nope"), three);
});

test("shiftGroup reorders groups and stops at the ends", () => {
  assert.deepEqual(shiftGroup(three, "p", 1).groups.map((group) => group.id), ["w", "x", "p"]);
  assert.deepEqual(shiftGroup(three, "p", -1).groups.map((group) => group.id), ["p", "w", "x"]);
  assert.equal(shiftGroup(three, "w", -1), three);
  assert.equal(shiftGroup(three, "p", 1).activeGroupId, "p");
});

test("setGroupProjects replaces one group's projects, deduped", () => {
  const next = setGroupProjects(three, "w", ["P3", "P1", "P3"]);
  assert.deepEqual(next.groups[0]?.projectUids, ["P3", "P1"]);
  assert.equal(next.groups[1], three.groups[1]);
  assert.equal(setGroupProjects(three, "w", ["P1", "P2"]), three);
  assert.equal(setGroupProjects(three, "nope", ["P1"]), three);
});

test("toggleGroupProject appends or takes out", () => {
  assert.deepEqual(toggleGroupProject(three, "w", "P3").groups[0]?.projectUids, ["P1", "P2", "P3"]);
  assert.deepEqual(toggleGroupProject(three, "w", "P1").groups[0]?.projectUids, ["P2"]);
  assert.equal(toggleGroupProject(three, "nope", "P1"), three);
});

test("groupsOf lists a project's groups in order", () => {
  assert.deepEqual(groupsOf(three, "P1").map((group) => group.name), ["Work", "Personal"]);
  assert.deepEqual(groupsOf(three, "P9"), []);
});

test("tabOnSwitch prefers the remembered tab, then the current one, then the first", () => {
  assert.equal(tabOnSwitch(["P1", "P2", "P3"], "P1", "P3"), "P3");
  assert.equal(tabOnSwitch(["P1", "P2"], "P2", "P9"), "P2");
  assert.equal(tabOnSwitch(["P1", "P2"], "P2", undefined), "P2");
  assert.equal(tabOnSwitch(["P1", "P2"], "P9", "P8"), "P1");
  assert.equal(tabOnSwitch(["P1", "P2"], null, undefined), "P1");
  assert.equal(tabOnSwitch([], "P1", "P1"), null);
});

test("rememberTab records the active group's tab, never a visiting one", () => {
  const none = {};
  assert.deepEqual(rememberTab(none, three, "P1"), { p: "P1" });
  assert.equal(rememberTab(none, three, "P2"), none);
  assert.equal(rememberTab(none, three, null), none);
  assert.equal(rememberTab(none, null, "P1"), none);
  const known = { p: "P1", w: "P2" };
  assert.equal(rememberTab(known, three, "P1"), known);
  assert.deepEqual(rememberTab(known, activateGroup(three, "w"), "P1"), { p: "P1", w: "P1" });
});

test("findGroups matches the id, then the exact name, then the name ignoring case", () => {
  const groups = {
    groups: [
      { id: "w", name: "Work", projectUids: [] },
      { id: "x", name: "work", projectUids: [] },
      { id: "Work", name: "Odd", projectUids: [] },
      { id: "p", name: "Personal", projectUids: [] },
    ],
    activeGroupId: "w",
  };
  assert.deepEqual(findGroups(groups, "Work").map((group) => group.id), ["Work"]);
  assert.deepEqual(findGroups(groups, "work").map((group) => group.id), ["x"]);
  assert.deepEqual(findGroups(groups, " personal ").map((group) => group.id), ["p"]);
  assert.deepEqual(findGroups(groups, "WORK").map((group) => group.id), ["w", "x"]);
  assert.deepEqual(findGroups(groups, "nope"), []);
});
