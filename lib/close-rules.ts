// What kata's daemon demands of a close, as probed against v0.16.0 with
// `dry_run` (source "tui", the human path): `done` needs nothing, the others
// need a substantive message, and duplicate/superseded need exactly one
// target issue as evidence. Zod-free so the app bundle can use it for hints;
// the daemon stays the authority and its error is shown if these drift.

export const CLOSE_REASONS = ["done", "wontfix", "duplicate", "superseded"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export interface CloseRule {
  label: string;
  /** Key that picks this reason in the close menu. */
  key: string;
  minMessage: number;
  /** Evidence type naming the target issue, when one is required. */
  target: "duplicate-of" | "superseded-by" | null;
}

export const CLOSE_RULES: Record<CloseReason, CloseRule> = {
  done: { label: "done", key: "d", minMessage: 0, target: null },
  wontfix: { label: "wontfix", key: "w", minMessage: 60, target: null },
  duplicate: { label: "duplicate of…", key: "u", minMessage: 20, target: "duplicate-of" },
  superseded: { label: "superseded by…", key: "s", minMessage: 20, target: "superseded-by" },
};

/** Why the close cannot be sent yet, or null when it looks valid. */
export function closeProblem(reason: CloseReason, message: string, targetRef: string): string | null {
  const rule = CLOSE_RULES[reason];
  if (rule.target !== null && targetRef.trim() === "") return `${reason} needs the other issue's id`;
  const length = message.trim().replace(/\s+/gu, " ").length;
  if (length < rule.minMessage) {
    return `${reason} needs a message of ${rule.minMessage}+ characters (${length} so far)`;
  }
  return null;
}

// ---- agent closes (CLI and agent tools) ----------------------------------------
//
// Without `source: "tui"` the daemon is stricter (probed on v0.16.0 with
// `dry_run`): `done` needs a 40+ character message *and* at least one
// evidence item; wontfix 60+, duplicate/superseded 20+ plus the target.
// `bb kata` and the agent tools never claim to be the TUI.

export const AGENT_MIN_MESSAGE: Record<CloseReason, number> = {
  done: 40,
  wontfix: 60,
  duplicate: 20,
  superseded: 20,
};

/** Evidence kinds the daemon accepts for `done`, with the field each fills. */
export const EVIDENCE_KINDS = {
  commit: "sha",
  pr: "url",
  test: "command",
  "reviewed-paths": "paths",
  external: "account",
} as const;
export type EvidenceKind = keyof typeof EVIDENCE_KINDS;
