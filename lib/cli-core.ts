// Pure pieces of `bb kata` and the kata agent tools: ref parsing, project
// resolution precedence, argv-level values → daemon request bodies, and
// bounded text formatting. No SDK or network access, so it is unit tested;
// lib/kata-service.ts wires it to the daemon and bb.
import {
  AGENT_MIN_MESSAGE,
  EVIDENCE_KINDS,
  type CloseReason,
  type EvidenceKind,
} from "./close-rules.ts";
import type { IssueListFilter } from "./kata-client.ts";
import { issueDirective, REF_HINT, tryParseRef, type ParsedRef } from "./refs.ts";
import type {
  KataCreateIssueBody,
  KataEvidence,
  KataIssue,
  KataIssueDetail,
  KataLinkPeer,
  KataProject,
} from "./kata-types.ts";

/** A usage/validation failure with a hint naming the fix (→ PluginCliError / tool error). */
export class KataUsageError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.name = "KataUsageError";
    this.code = code;
    this.hint = hint;
  }
}

// ---- refs ---------------------------------------------------------------------------

export type { ParsedRef } from "./refs.ts";

/** `abc4`, `project#abc4`, or a ULID (any case). */
export function parseRef(raw: string): ParsedRef {
  const parsed = tryParseRef(raw);
  if (parsed) return parsed;
  throw new KataUsageError(`not an issue ref: ${JSON.stringify(raw.slice(0, 80))}`, "invalid_ref", REF_HINT);
}

// ---- project resolution --------------------------------------------------------------

export interface ProjectInputs {
  /** `--project <name|uid|id>`. */
  explicit?: string | undefined;
  /** A project named by the ref itself (qualified ref's name, or a ULID's owning project). */
  fromRef?: { name?: string; id?: number } | undefined;
  threadId?: string | undefined;
  projectId?: string | undefined;
}

export interface ProjectResolverDeps {
  projects(): Promise<KataProject[]>;
  /** Kata project bound to the thread's bb project, or null. */
  forThread(threadId: string): Promise<KataProject | null>;
  /** Kata project bound to a bb project, or null. */
  forProject(projectId: string): Promise<KataProject | null>;
}

export type ProjectSource = "flag" | "ref" | "thread" | "project";

export function findProject(projects: KataProject[], key: string): KataProject | null {
  const text = key.trim();
  return (
    projects.find((p) => p.name === text) ??
    projects.find((p) => p.uid.toUpperCase() === text.toUpperCase()) ??
    (/^\d+$/u.test(text) ? projects.find((p) => p.id === Number(text)) : undefined) ??
    projects.find((p) => p.name.toLowerCase() === text.toLowerCase()) ??
    null
  );
}

const namesOf = (projects: KataProject[]) => projects.map((p) => p.name).join(", ") || "(none)";

/**
 * Which kata project a command acts on: `--project` > the ref's own project >
 * the thread's binding > the bb project's binding. A ref naming a different
 * project than `--project` is an error rather than a guess.
 */
export async function resolveProject(
  inputs: ProjectInputs,
  deps: ProjectResolverDeps,
  usage: string,
): Promise<{ project: KataProject; source: ProjectSource }> {
  const projects = await deps.projects();
  const refProject = inputs.fromRef
    ? inputs.fromRef.id !== undefined
      ? (projects.find((p) => p.id === inputs.fromRef!.id) ?? null)
      : findProject(projects, inputs.fromRef.name ?? "")
    : null;
  if (inputs.fromRef && refProject === null) {
    throw new KataUsageError(
      `no kata project ${JSON.stringify(inputs.fromRef.name ?? String(inputs.fromRef.id))}`,
      "project_not_found",
      `Kata projects: ${namesOf(projects)}.`,
    );
  }
  if (inputs.explicit !== undefined && inputs.explicit.trim() !== "") {
    const project = findProject(projects, inputs.explicit);
    if (project === null) {
      throw new KataUsageError(
        `no kata project ${JSON.stringify(inputs.explicit)}`,
        "project_not_found",
        `Pass one of: ${namesOf(projects)} (name, uid or numeric id).`,
      );
    }
    if (refProject && refProject.id !== project.id) {
      throw new KataUsageError(
        `the ref belongs to ${refProject.name}, but --project is ${project.name}`,
        "project_conflict",
        `Drop --project, or use a bare short id.`,
      );
    }
    return { project, source: "flag" };
  }
  if (refProject) return { project: refProject, source: "ref" };
  if (inputs.threadId) {
    const bound = await deps.forThread(inputs.threadId);
    if (bound) return { project: bound, source: "thread" };
  }
  if (inputs.projectId) {
    const bound = await deps.forProject(inputs.projectId);
    if (bound) return { project: bound, source: "project" };
  }
  const example = projects[0]?.name ?? "<name>";
  throw new KataUsageError(
    "no kata project: this thread's project has no .kata.toml naming one",
    "project_required",
    `Add \`--project <name>\`, e.g. \`${usage} --project ${example}\`. Kata projects: ${namesOf(projects)}.`,
  );
}

// ---- argv values → daemon requests ----------------------------------------------------

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 500;

export interface ListOptions {
  status?: "open" | "closed" | "all";
  priority?: number;
  labels?: string[];
  owner?: string;
  unowned?: boolean;
  limit?: number;
}

export function listFilter(options: ListOptions): IssueListFilter {
  if (options.owner !== undefined && options.unowned) {
    throw new KataUsageError("--owner and --unowned exclude each other", "invalid_value");
  }
  const limit = Math.min(Math.max(options.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const filter: IssueListFilter = { status: options.status ?? "open", limit };
  if (options.priority !== undefined) filter.priority = options.priority;
  if (options.owner) filter.owner = options.owner;
  if (options.unowned) filter.unowned = true;
  const labels = cleanLabels(options.labels);
  if (labels.length > 0) filter.labels = labels;
  return filter;
}

export function cleanLabels(labels: readonly string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((l) => l.trim()).filter((l) => l !== ""))];
}

/** `0`..`4`, or `-`/`none`/`clear` for unset. */
export function parsePriority(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/^p/u, "");
  if (text === "-" || text === "none" || text === "clear") return null;
  if (/^[0-4]$/u.test(text)) return Number(text);
  throw new KataUsageError(
    `priority must be 0-4 or - (got ${JSON.stringify(raw.slice(0, 20))})`,
    "invalid_value",
    "0 is the highest priority; `-` clears it.",
  );
}

export interface CreateOptions {
  title: string;
  body?: string;
  priority?: number;
  parent?: string;
  labels?: string[];
  blockedBy?: string[];
  blocks?: string[];
  related?: string[];
}

/** Checks each link ref's shape; the daemon resolves it (qualified refs may cross projects). */
function linkRef(raw: string): string {
  parseRef(raw);
  return raw.trim();
}

export function createBody(options: CreateOptions, actor: string): KataCreateIssueBody {
  const title = options.title.trim();
  if (title === "") throw new KataUsageError("the title is empty", "invalid_value");
  if (title.length > 500) throw new KataUsageError("the title is over 500 characters", "invalid_value");
  const body: KataCreateIssueBody = { title, actor };
  if (options.body?.trim()) body.body = options.body;
  if (options.priority !== undefined) body.priority = options.priority;
  const labels = cleanLabels(options.labels);
  if (labels.length > 0) body.labels = labels;
  const links: NonNullable<KataCreateIssueBody["links"]> = [];
  if (options.parent) links.push({ type: "parent", to_ref: linkRef(options.parent) });
  for (const ref of options.blocks ?? []) links.push({ type: "blocks", to_ref: linkRef(ref) });
  for (const ref of options.blockedBy ?? []) links.push({ type: "blocks", to_ref: linkRef(ref), incoming: true });
  for (const ref of options.related ?? []) links.push({ type: "related", to_ref: linkRef(ref) });
  if (links.length > 0) body.links = links;
  return body;
}

/** `commit:<sha>`, `pr:<url>`, `test:<cmd>`, `reviewed-paths:<a,b>`, `external:<account>`. */
export function parseEvidence(raw: string): KataEvidence {
  const colon = raw.indexOf(":");
  const kind = (colon === -1 ? raw : raw.slice(0, colon)).trim() as EvidenceKind;
  const value = colon === -1 ? "" : raw.slice(colon + 1).trim();
  const field = EVIDENCE_KINDS[kind];
  if (!field || value === "") {
    throw new KataUsageError(
      `bad evidence ${JSON.stringify(raw.slice(0, 80))}`,
      "invalid_value",
      "Evidence is <kind>:<value> with kind commit, pr, test, reviewed-paths (comma-separated) or external, e.g. `--evidence test:\"npm test\"`.",
    );
  }
  if (field === "paths") {
    const paths = value.split(",").map((p) => p.trim()).filter((p) => p !== "");
    return { type: kind, paths };
  }
  return { type: kind, [field]: value };
}

export interface CloseOptions {
  reason: CloseReason;
  message?: string;
  /** Target issue for duplicate / superseded. */
  target?: string;
  evidence?: KataEvidence[];
  dryRun?: boolean;
}

const normalizedLength = (text: string) => text.trim().replace(/\s+/gu, " ").length;

const needsReview =
  "If the work is not actually complete, do not close: `bb kata label <ref> add needs-review` and comment what remains.";

/** The `actions/close` body, with the daemon's rules checked up front so the hint is exact. */
export function closeBody(options: CloseOptions, actor: string): Record<string, unknown> {
  const { reason } = options;
  const message = options.message?.trim() ?? "";
  const min = AGENT_MIN_MESSAGE[reason];
  const got = normalizedLength(message);
  if (got < min) {
    throw new KataUsageError(
      `${reason} needs a message of ${min}+ characters (got ${got})`,
      "close_rejected",
      reason === "done"
        ? `Say what was done and how it was verified, e.g. \`--message "..." --evidence test:"npm test"\`. ${needsReview}`
        : `Explain why with \`--message\`. ${needsReview}`,
    );
  }
  const evidence = [...(options.evidence ?? [])];
  if (reason === "done" && evidence.length === 0) {
    throw new KataUsageError(
      "done needs at least one --evidence item",
      "close_rejected",
      `Accepted: commit:<sha>, pr:<url>, test:<cmd>, reviewed-paths:<path,...>, external:<account>. ${needsReview}`,
    );
  }
  if (reason === "duplicate" || reason === "superseded") {
    if (!options.target) throw new KataUsageError(`${reason} needs the other issue's ref`, "close_rejected");
    parseRef(options.target);
    evidence.push({ type: reason === "duplicate" ? "duplicate-of" : "superseded-by", issue_ref: options.target.trim() });
  }
  return {
    actor,
    reason,
    message,
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(options.dryRun ? { dry_run: true } : {}),
  };
}

// ---- formatting --------------------------------------------------------------------------

/** Priority ascending (unset last), then most recently updated. */
export function sortIssues<T extends Pick<KataIssue, "priority" | "updated_at">>(issues: T[]): T[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? 9;
    const pb = b.priority ?? 9;
    if (pa !== pb) return pa - pb;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const priorityLabel = (priority: number | undefined | null) =>
  priority === undefined || priority === null ? "--" : `P${priority}`;

type LineIssue = Pick<KataIssue, "short_id" | "title" | "status" | "priority" | "owner"> & {
  labels?: string[] | null;
};

/** `P2 abc4  title  [labels] @owner` (plus `(closed)` for closed issues). */
export function issueLine(issue: LineIssue): string {
  let line = `${priorityLabel(issue.priority)} ${issue.short_id}  ${oneLine(issue.title, 160)}`;
  if (issue.labels && issue.labels.length > 0) line += `  [${issue.labels.slice(0, 10).join(", ")}]`;
  if (issue.owner) line += ` @${issue.owner}`;
  if (issue.status !== "open") line += ` (${issue.status})`;
  return line;
}

export const MAX_SHOWN_COMMENTS = 20;
const MAX_BODY = 20_000;
const MAX_COMMENT = 4_000;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;

const peer = (p: KataLinkPeer) =>
  `${p.qualified_id}${p.status === "open" ? "" : ` (${p.status})`}${p.title ? `  ${oneLine(p.title, 120)}` : ""}`;

export function formatDetail(detail: KataIssueDetail): string {
  const { issue } = detail;
  const out: string[] = [
    `${issue.qualified_id}  ${oneLine(issue.title, 300)}`,
    `uid ${issue.uid}  status ${issue.status}${issue.closed_reason ? ` (${issue.closed_reason})` : ""}  priority ${priorityLabel(issue.priority)}`,
    `owner ${issue.owner ?? "-"}  author ${issue.author}  labels ${issue.labels?.length ? issue.labels.join(", ") : "-"}`,
    `updated ${issue.updated_at}`,
  ];
  const directive = issueDirective(issue.qualified_id);
  if (directive) out.push(`mention in chat as: ${directive}`);
  const rel = (name: string, peers: KataLinkPeer[] | null | undefined) => {
    if (peers && peers.length > 0) out.push(`${name}:`, ...peers.slice(0, 50).map((p) => `  ${peer(p)}`));
  };
  if (issue.parent) out.push(`parent: ${peer(issue.parent)}`);
  rel("children", detail.children);
  rel("blocked by", issue.blocked_by);
  rel("blocks", issue.blocks);
  rel("related", issue.related);
  out.push("", issue.body.trim() === "" ? "(no body)" : clip(issue.body, MAX_BODY));
  const comments = detail.comments;
  if (comments.length > 0) {
    const shown = comments.slice(-MAX_SHOWN_COMMENTS);
    out.push("", `comments (${comments.length}${shown.length < comments.length ? `, showing the last ${shown.length}` : ""}):`);
    for (const c of shown) out.push(`--- ${c.author} ${c.created_at}`, clip(c.body, MAX_COMMENT));
  }
  return out.join("\n");
}

/** The detail as JSON, with the same caps as the text form. */
export function detailJson(detail: KataIssueDetail) {
  const comments = detail.comments.slice(-MAX_SHOWN_COMMENTS).map((c) => ({ ...c, body: c.body.slice(0, MAX_COMMENT) }));
  return {
    issue: { ...detail.issue, body: detail.issue.body.slice(0, MAX_BODY) },
    directive: issueDirective(detail.issue.qualified_id),
    children: detail.children,
    comments,
    commentsTotal: detail.comments.length,
    commentsTruncated: comments.length < detail.comments.length,
  };
}

/** List rows as JSON: bodies clipped so 500 rows stay well under the output cap. */
export function listJson(issues: KataIssue[]) {
  return issues.map(({ body, ...rest }) => ({ ...rest, body: body.slice(0, 1000) }));
}

/**
 * Cut text to `maxBytes` UTF-8 bytes with a trailing note, so no command can
 * exceed PLUGIN_CLI_OUTPUT_MAX_BYTES (the host rejects rather than clips).
 */
export function boundText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const note = "\n… (output truncated)\n";
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes - Buffer.byteLength(note));
  return `${buf.toString("utf8").replace(/�$/u, "")}${note}`;
}
