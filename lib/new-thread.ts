// `t` in the Kata panel: start a bb thread on the selected issue. The draft
// is left in the new-thread composer for the user to finish and send; the
// plugin never submits it. A blank draft gets the issue line (and the bound
// project); a non-blank one keeps its text and project and gets the line
// appended as a new paragraph.

export interface BoundProject {
  id: string;
  name: string;
}

/**
 * The composer text for a thread on one issue: one line the user can edit,
 * pointing the agent at the plugin's CLI for the issue's details.
 */
export function newThreadDraft(issue: { qualified_id: string; title: string }): string {
  const title = issue.title.replace(/\s+/gu, " ").trim();
  return `Work on kata issue ${issue.qualified_id}: "${title}". Run \`bb kata show ${issue.qualified_id}\` for full details.`;
}

/** Whitespace-only counts as blank. */
export const isBlankDraft = (text: string): boolean => text.trim() === "";

/** The draft after `t`: the line alone when the draft is blank, else the draft with the line as a new paragraph. */
export function mergeDraft(existing: string, line: string): string {
  return isBlankDraft(existing) ? line : `${existing.trimEnd()}\n\n${line}`;
}

/** The bb project a new thread goes to: the first bound one, with a note when there was a choice. */
export function pickBoundProject(
  bound: readonly BoundProject[],
): { project: BoundProject; note: string | null } | null {
  const [project, ...others] = bound;
  if (project === undefined) return null;
  const note = others.length === 0 ? null : `also bound: ${others.map((p) => p.name).join(", ")}`;
  return { project, note };
}
