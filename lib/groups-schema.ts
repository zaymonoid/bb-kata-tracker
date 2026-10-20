// The `projectGroups` setting's zod schema, parsing and validation. Kept apart
// from lib/groups.ts so the frontend can use the group transformations there
// without pulling zod into its bundle. server.ts, the RPC contract and tests
// import this file; the panel never does.
import { z } from "zod";
import { normalizeGroups, newGroupId, isUnsetGroups, type ProjectGroups } from "./groups.ts";

const uid = z.string().min(1).max(64);

const projectGroupSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  projectUids: z.array(uid).max(64),
});

export const projectGroupsSchema = z.object({
  groups: z.array(projectGroupSchema).max(64),
  activeGroupId: z.string().max(64),
});

// The plain types in lib/groups.ts must stay what the schema reads.
projectGroupsSchema satisfies z.ZodType<ProjectGroups>;

/** Whether a `projectGroups` setting value is valid (empty counts: it means unset). */
export function isValidGroupsSetting(value: string): boolean {
  if (isUnsetGroups(value)) return true;
  try {
    return projectGroupsSchema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

/** Parse the `projectGroups` setting; empty or invalid reads as one empty group. */
export function parseGroups(value: string, newId: () => string = newGroupId): ProjectGroups {
  let parsed: ProjectGroups = { groups: [], activeGroupId: "" };
  try {
    const result = projectGroupsSchema.safeParse(JSON.parse(value));
    if (result.success) parsed = result.data;
  } catch {
    // keep the empty value
  }
  return normalizeGroups(parsed, newId);
}
