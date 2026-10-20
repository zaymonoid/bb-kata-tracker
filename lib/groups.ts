// Project groups: named, ordered lists of kata project uids. Groups are
// overlays, not partitions: a project may be in several groups or in none.
// Exactly one group is active; the tab strip shows the active group's
// projects. Persisted as JSON in the `projectGroups` setting, and the active
// group's projects are mirrored into `includedProjects` (see server.ts).
//
// Pure and zod-free, so the panel and the picker use these transformations
// directly. The setting's schema and parser are in lib/groups-schema.ts.
// Every edit returns the value it was given when nothing changes, so a caller
// can skip the save (as lib/reorder.ts does).
import { shiftBy } from "./reorder.ts";

export interface ProjectGroup {
  id: string;
  name: string;
  projectUids: string[];
}

export interface ProjectGroups {
  groups: ProjectGroup[];
  activeGroupId: string;
}

/** Name of the group made from `includedProjects`, or when there are none. */
export const DEFAULT_GROUP_NAME = "Projects";

/** Longest group name the setting accepts. */
export const MAX_GROUP_NAME = 100;

/** A short random group id. */
export function newGroupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

/**
 * Drop groups with a duplicate id (the first wins), dedupe each group's
 * projects, point `activeGroupId` at the first group when it names none, and
 * make one empty "Projects" group when there are no groups.
 */
export function normalizeGroups(value: ProjectGroups, newId: () => string = newGroupId): ProjectGroups {
  const seen = new Set<string>();
  const groups: ProjectGroup[] = [];
  for (const group of value.groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    groups.push({ id: group.id, name: group.name, projectUids: [...new Set(group.projectUids)] });
  }
  if (groups.length === 0) groups.push({ id: newId(), name: DEFAULT_GROUP_NAME, projectUids: [] });
  const activeGroupId = seen.has(value.activeGroupId) ? value.activeGroupId : groups[0]!.id;
  return { groups, activeGroupId };
}

/** Whether the `projectGroups` setting has never been written (its default). */
export const isUnsetGroups = (value: string) => value.trim() === "";

export const serializeGroups = (value: ProjectGroups) => JSON.stringify(value);

/** One "Projects" group holding `projectUids`, active: the migration from `includedProjects`. */
export function groupsFromIncluded(projectUids: readonly string[], newId: () => string = newGroupId): ProjectGroups {
  const id = newId();
  return normalizeGroups({ groups: [{ id, name: DEFAULT_GROUP_NAME, projectUids: [...projectUids] }], activeGroupId: id }, newId);
}

/** The active group, or null when `activeGroupId` names none. */
export const activeGroup = (value: ProjectGroups): ProjectGroup | null =>
  value.groups.find((group) => group.id === value.activeGroupId) ?? null;

/** The active group's projects, in tab order. */
export const activeProjectUids = (value: ProjectGroups): string[] => activeGroup(value)?.projectUids ?? [];

/** Replace the active group's projects; other groups are unchanged. */
export function withActiveProjects(value: ProjectGroups, projectUids: readonly string[]): ProjectGroups {
  return normalizeGroups({
    ...value,
    groups: value.groups.map((group) =>
      group.id === value.activeGroupId ? { ...group, projectUids: [...projectUids] } : group,
    ),
  });
}

// ---- edits (the picker, the strip) -----------------------------------------

const sameUids = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((uid, i) => uid === b[i]);

/** A name as saved: trimmed and cut to the setting's limit; empty means none. */
const cleanName = (name: string) => name.trim().slice(0, MAX_GROUP_NAME).trim();

/** Make `groupId` the active group. */
export function activateGroup(value: ProjectGroups, groupId: string): ProjectGroups {
  if (groupId === value.activeGroupId || !value.groups.some((group) => group.id === groupId)) return value;
  return { ...value, activeGroupId: groupId };
}

/** Make the group `delta` places after the active one active, wrapping (`⌘[` / `⌘]`). */
export function stepGroup(value: ProjectGroups, delta: number): ProjectGroups {
  const count = value.groups.length;
  if (count < 2 || !Number.isFinite(delta)) return value;
  const index = value.groups.findIndex((group) => group.id === value.activeGroupId);
  const next = value.groups[(((index + Math.trunc(delta)) % count) + count) % count];
  return next === undefined ? value : activateGroup(value, next.id);
}

/** Append an empty group named `name` and make it active. A blank name adds nothing. */
export function addGroup(value: ProjectGroups, name: string, id: string = newGroupId()): ProjectGroups {
  const clean = cleanName(name);
  if (clean === "" || value.groups.some((group) => group.id === id)) return value;
  return { groups: [...value.groups, { id, name: clean, projectUids: [] }], activeGroupId: id };
}

/** Rename `groupId`. A blank name renames nothing. */
export function renameGroup(value: ProjectGroups, groupId: string, name: string): ProjectGroups {
  const clean = cleanName(name);
  const group = value.groups.find((other) => other.id === groupId);
  if (clean === "" || group === undefined || group.name === clean) return value;
  return { ...value, groups: value.groups.map((other) => (other === group ? { ...other, name: clean } : other)) };
}

/**
 * Remove `groupId`. Its projects stay in any other group they are in (groups
 * are overlays). When it was active, the group before it becomes active (the
 * next one when it was first). The last group is never removed.
 */
export function removeGroup(value: ProjectGroups, groupId: string): ProjectGroups {
  const index = value.groups.findIndex((group) => group.id === groupId);
  if (index < 0 || value.groups.length < 2) return value;
  const groups = value.groups.filter((group) => group.id !== groupId);
  const activeGroupId =
    groupId === value.activeGroupId ? groups[Math.max(index - 1, 0)]!.id : value.activeGroupId;
  return { groups, activeGroupId };
}

/** Move `groupId` one place left (`-1`) or right (`1`) among the groups. */
export function shiftGroup(value: ProjectGroups, groupId: string, delta: number): ProjectGroups {
  const ids = value.groups.map((group) => group.id);
  const next = shiftBy(ids, groupId, delta);
  if (next === ids) return value;
  return { ...value, groups: next.map((id) => value.groups.find((group) => group.id === id)!) };
}

/** Replace the projects of `groupId` (deduped, in the order given). */
export function setGroupProjects(value: ProjectGroups, groupId: string, projectUids: readonly string[]): ProjectGroups {
  const group = value.groups.find((other) => other.id === groupId);
  const uids = [...new Set(projectUids)];
  if (group === undefined || sameUids(group.projectUids, uids)) return value;
  return {
    ...value,
    groups: value.groups.map((other) => (other === group ? { ...other, projectUids: uids } : other)),
  };
}

/** Add `projectUid` to the end of `groupId`, or take it out. */
export function toggleGroupProject(value: ProjectGroups, groupId: string, projectUid: string): ProjectGroups {
  const group = value.groups.find((other) => other.id === groupId);
  if (group === undefined) return value;
  const uids = group.projectUids.includes(projectUid)
    ? group.projectUids.filter((uid) => uid !== projectUid)
    : [...group.projectUids, projectUid];
  return setGroupProjects(value, groupId, uids);
}

/** The groups `projectUid` is in, in group order. */
export const groupsOf = (value: ProjectGroups, projectUid: string): ProjectGroup[] =>
  value.groups.filter((group) => group.projectUids.includes(projectUid));

// ---- switching back to a group, finding one by name ------------------------

/**
 * The tab to show after switching to a group with `projectUids`: the tab last
 * shown in that group while it was still there, else the current tab when the
 * group has it, else the group's first project (null when it has none).
 */
export function tabOnSwitch(
  projectUids: readonly string[],
  current: string | null,
  remembered: string | undefined,
): string | null {
  if (remembered !== undefined && projectUids.includes(remembered)) return remembered;
  if (current !== null && projectUids.includes(current)) return current;
  return projectUids[0] ?? null;
}

/**
 * Remember `activeUid` as the active group's tab, when it is one of the
 * group's projects (a visiting tab is not). Returns `byGroup` when nothing
 * changes.
 */
export function rememberTab(
  byGroup: Readonly<Record<string, string>>,
  groups: ProjectGroups | null,
  activeUid: string | null,
): Readonly<Record<string, string>> {
  if (groups === null || activeUid === null) return byGroup;
  const id = groups.activeGroupId;
  if (byGroup[id] === activeUid || !activeProjectUids(groups).includes(activeUid)) return byGroup;
  return { ...byGroup, [id]: activeUid };
}

/**
 * Groups matching `key`, by the first rule that matches any: the id, the
 * exact name, the name ignoring case. More than one means the name is
 * ambiguous (names need not be unique).
 */
export function findGroups(value: ProjectGroups, key: string): ProjectGroup[] {
  const text = key.trim();
  const byId = value.groups.filter((group) => group.id === text);
  if (byId.length > 0) return byId;
  const exact = value.groups.filter((group) => group.name === text);
  if (exact.length > 0) return exact;
  return value.groups.filter((group) => group.name.toLowerCase() === text.toLowerCase());
}
