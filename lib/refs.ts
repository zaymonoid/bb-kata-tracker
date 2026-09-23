// Kata issue refs, shared by the server (lib/cli-core.ts) and the app bundle:
// pure regexes, no zod, no Node APIs.
//
// - `abc4`: a short id, resolved against some project
// - `project#abc4`: qualified
// - a 26-character ULID (any case)
//
// Also the `::kata-issue{…}` directive's attribute validation and the ref
// extraction the "open issue from selection" message action uses.

export type ParsedRef =
  | { kind: "short"; ref: string }
  | { kind: "qualified"; project: string; ref: string }
  | { kind: "uid"; ref: string };

const ULID_ANY_CASE = /^[0-9A-HJKMNP-TV-Z]{26}$/iu;
const SHORT = /^[a-z0-9]{1,16}$/iu;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

export const REF_HINT = "Refs look like `abc4`, `project#abc4`, or a 26-character issue ULID.";

/** `abc4`, `project#abc4`, or a ULID (any case); null when it is none of them. */
export function tryParseRef(raw: string): ParsedRef | null {
  const text = raw.trim();
  if (ULID_ANY_CASE.test(text)) return { kind: "uid", ref: text.toUpperCase() };
  const hash = text.indexOf("#");
  if (hash === -1) return SHORT.test(text) ? { kind: "short", ref: text.toLowerCase() } : null;
  const project = text.slice(0, hash);
  const ref = text.slice(hash + 1);
  return PROJECT_NAME.test(project) && SHORT.test(ref) ? { kind: "qualified", project, ref: ref.toLowerCase() } : null;
}

export const isUlid = (text: string) => ULID_ANY_CASE.test(text);

/** The canonical text of a parsed ref. */
export function formatRef(ref: ParsedRef): string {
  return ref.kind === "qualified" ? `${ref.project}#${ref.ref}` : ref.ref;
}

/** A ready-to-paste directive for a qualified id, or null when it is not a clean `project#abc4`. */
export function issueDirective(qualifiedId: string): string | null {
  const parsed = tryParseRef(qualifiedId);
  return parsed?.kind === "qualified" ? `::kata-issue{ref="${formatRef(parsed)}"}` : null;
}

// ---- ::kata-issue{ref="…"} / {uid="…"} ---------------------------------------------

const MAX_ATTRIBUTE = 200;

export type IssueDirective =
  | { ok: true; ref: ParsedRef; /** Text to show until it resolves. */ label: string }
  | { ok: false; reason: string; label: string };

/**
 * Validate the directive's (untrusted) attributes. `uid` wins when it is a
 * ULID; otherwise `ref` must be a short id, `project#abc4`, or a ULID.
 * Unknown attributes are ignored.
 */
export function parseIssueDirective(attributes: Readonly<Record<string, unknown>>): IssueDirective {
  const read = (key: string) => {
    const value = Object.hasOwn(attributes, key) ? attributes[key] : undefined;
    return typeof value === "string" && value.length <= MAX_ATTRIBUTE ? value.trim() : null;
  };
  const uid = read("uid");
  const ref = read("ref");
  const refParsed = ref ? tryParseRef(ref) : null;
  const label = refParsed ? formatRef(refParsed) : uid && isUlid(uid) ? `${uid.slice(0, 6)}…${uid.slice(-4)}` : "kata issue";
  if (uid && isUlid(uid)) return { ok: true, ref: { kind: "uid", ref: uid.toUpperCase() }, label };
  if (refParsed) return { ok: true, ref: refParsed, label };
  if (uid || ref) return { ok: false, reason: "not a kata issue ref", label: (ref || uid || "").slice(0, 40) || label };
  return { ok: false, reason: 'needs ref="project#abc4" or uid="<ULID>"', label };
}

// ---- refs in free text (selection) --------------------------------------------------

const TOKEN = /[A-Za-z0-9][A-Za-z0-9._-]*#[A-Za-z0-9]+|[A-Za-z0-9]+/gu;
/** Selections longer than this only look for qualified refs and ULIDs. */
const MAX_BARE_WORDS = 12;
const MAX_CANDIDATES = 10;

/**
 * Candidate refs in selected text, most specific first: qualified refs,
 * then ULIDs. Only when there are none, bare short ids — and only in a
 * short selection (a bare `abc4` looks like any word), words holding a
 * digit first. The server resolves them in order and takes the first that exists.
 */
export function extractRefs(text: string): string[] {
  const clipped = text.slice(0, 4000);
  const tokens = clipped.match(TOKEN) ?? [];
  const qualified: string[] = [];
  const uids: string[] = [];
  const words: string[] = [];
  for (const token of tokens) {
    const cleaned = token.replace(/[._-]+$/u, "");
    const parsed = tryParseRef(cleaned);
    if (parsed === null) continue;
    if (parsed.kind === "qualified") qualified.push(formatRef(parsed));
    else if (parsed.kind === "uid") uids.push(parsed.ref);
    else words.push(parsed.ref);
  }
  let bare: string[] = [];
  if (qualified.length === 0 && uids.length === 0 && words.length <= MAX_BARE_WORDS) {
    const plausible = words.filter((word) => word.length >= 3 && word.length <= 8);
    bare = [...plausible.filter((w) => /\d/u.test(w)), ...plausible.filter((w) => !/\d/u.test(w))];
  }
  return [...new Set([...qualified, ...uids, ...bare])].slice(0, MAX_CANDIDATES);
}

// ---- "open this issue" targets (thread panel params, nav panel requests) ---------------

export interface IssueTarget {
  issueUid: string;
  projectUid: string;
  /** For titles and hints only. */
  qualifiedId: string | null;
}

/** A thread panel's persisted `params` (untrusted JSON) as a target, or null. */
export function readIssueTarget(value: unknown): IssueTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { issueUid, projectUid, qualifiedId } = record;
  if (typeof issueUid !== "string" || !isUlid(issueUid)) return null;
  if (typeof projectUid !== "string" || !isUlid(projectUid)) return null;
  const parsed = typeof qualifiedId === "string" && qualifiedId.length <= MAX_ATTRIBUTE ? tryParseRef(qualifiedId) : null;
  return {
    issueUid: issueUid.toUpperCase(),
    projectUid: projectUid.toUpperCase(),
    qualifiedId: parsed?.kind === "qualified" ? formatRef(parsed) : null,
  };
}
