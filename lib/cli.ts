// `bb kata …`: the declarative CLI (defineCli). Parsing, help, and the
// `--json` error envelope come from the SDK; this file maps parsed values
// onto lib/kata-service.ts and formats bounded output.
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginCliRegistration,
} from "@get-bb/plugin-sdk";
import {
  boundText,
  detailJson,
  formatDetail,
  issueLine,
  KataUsageError,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  listJson,
  parseEvidence,
  parsePriority,
} from "./cli-core.ts";
import type { CloseReason } from "./close-rules.ts";
import { KataApiError, KataUnavailableError } from "./kata-client.ts";
import type { KataIssueDetail } from "./kata-types.ts";
import type { KataService, ListResult, Scope } from "./kata-service.ts";

/** Headroom under the host's cap for the envelope and stderr. */
const OUTPUT_BUDGET = PLUGIN_CLI_OUTPUT_MAX_BYTES - 16 * 1024;

type Ctx = { cwd?: string; threadId?: string; projectId?: string };

export interface KataCliDeps {
  service: KataService;
  /** Read a text file named on the invoking machine (relative to ctx.cwd). */
  readFile(path: string, ctx: Ctx): Promise<string>;
}

const projectOption = {
  type: "string",
  aliases: ["proj", "kata-project"],
  short: "p",
  placeholder: "name|uid",
  description:
    "Kata project (name, uid or numeric id). Default: the thread's project .kata.toml binding. A qualified ref (project#abc4) overrides it.",
} as const;
const jsonOption = { type: "boolean", description: "Print JSON instead of text" } as const;
const refPositional = {
  name: "ref",
  description: "Issue: abc4, project#abc4, or the issue ULID",
  required: true,
} as const;
const labelOption = {
  type: "string",
  repeatable: true,
  split: ",",
  aliases: ["labels", "tag"],
  short: "l",
  description: "Label (comma-separated values allowed)",
} as const;
const priorityOption = {
  type: "integer",
  min: 0,
  max: 4,
  aliases: ["prio", "p0"],
  description: "Priority 0-4 (0 is highest)",
} as const;
const bodyFileOption = {
  type: "string",
  placeholder: "path",
  description: "Read the body from a file on the invoking machine (relative to the current directory)",
} as const;

function toCliError(error: unknown): never {
  if (error instanceof PluginCliError) throw error;
  if (error instanceof KataUsageError) {
    throw new PluginCliError(error.message, { code: error.code, ...(error.hint ? { hint: error.hint } : {}) });
  }
  if (error instanceof KataApiError) {
    const hint =
      error.status === 404
        ? "Check the ref and --project; `bb kata list` or `bb kata search <query>` finds issues."
        : error.code === "validation" && /close|evidence|message too short/iu.test(error.message)
          ? "If the work is not actually complete, do not close: `bb kata label <ref> add needs-review` and comment what remains."
          : undefined;
    throw new PluginCliError(`kata: ${error.message}`, { code: `kata_${error.code}`, ...(hint ? { hint } : {}) });
  }
  if (error instanceof KataUnavailableError) {
    throw new PluginCliError(error.message, {
      code: "kata_unavailable",
      hint: "Is the kata daemon running? Check with `kata daemon status`.",
    });
  }
  throw error;
}

function out(text: string) {
  return { exitCode: 0, stdout: boundText(text.endsWith("\n") ? text : `${text}\n`, OUTPUT_BUDGET) };
}

function json(value: unknown) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > OUTPUT_BUDGET) {
    throw new PluginCliError("output too large", { code: "output_too_large", hint: "Lower --limit." });
  }
  return { exitCode: 0, stdout: text };
}

const scopeOf = (options: { project?: string | undefined }, ctx: Ctx, usage: string): Scope => ({
  project: options.project,
  threadId: ctx.threadId,
  projectId: ctx.projectId,
  usage,
});

function listText(result: ListResult, empty: string): string {
  if (result.issues.length === 0) return `${result.project.name}: ${empty}`;
  const lines = result.issues.map(issueLine);
  const more = result.total - result.issues.length;
  if (more > 0) lines.push(`… ${more} more (raise --limit, max ${LIST_MAX_LIMIT})`);
  if (result.capped) lines.push(`… the project has more than 2000 matching issues; narrow the filter`);
  return lines.join("\n");
}

const changed = (d: KataIssueDetail) => `${d.issue.qualified_id}  ${issueLine(d.issue)}`;

export function buildKataCli(deps: KataCliDeps): PluginCliRegistration {
  const { service } = deps;

  async function body(options: { body?: string | undefined; "body-file"?: string | undefined }, ctx: Ctx) {
    if (options.body !== undefined && options["body-file"] !== undefined) {
      throw new PluginCliError("--body and --body-file exclude each other", { code: "invalid_value" });
    }
    if (options["body-file"] !== undefined) return deps.readFile(options["body-file"], ctx);
    return options.body;
  }

  /** Every command body runs through this so kata errors become PluginCliErrors. */
  async function safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      toCliError(error);
    }
  }

  const mutationResult = (d: KataIssueDetail, asJson: boolean) => (asJson ? json(detailJson(d)) : out(changed(d)));

  const requireThread = (ctx: Ctx, thread: string | undefined, cmd: string) => {
    const id = thread ?? ctx.threadId;
    if (!id) {
      throw new PluginCliError("no thread: run this inside a bb thread", {
        code: "thread_required",
        hint: `Add \`--thread <thr_id>\`, e.g. \`bb kata ${cmd} --thread thr_abc123\`.`,
      });
    }
    return id;
  };
  const threadOption = {
    type: "string",
    placeholder: "thr_id",
    description: "Thread to act on (default: the thread running the command)",
  } as const;

  return defineCli({
    name: "kata",
    summary: "Work with the local kata issue tracker (list, show, create, prioritize, close, link threads)",
    description:
      "Talks to the kata daemon directly. The project comes from --project, a qualified ref (project#abc4), or the thread's .kata.toml binding. Close only verified work, always with a message; otherwise label needs-review and comment. Never delete issues.",
    commands: {
      projects: cliCommand({
        summary: "List kata projects: included in the viewer, bound bb projects",
        options: { json: jsonOption },
        run: ({ options }) => safe(async () => {
          const projects = await service.projects();
          if (options.json) return json({ projects });
          return out(
            projects
              .map(
                (p) =>
                  `${p.name}  id ${p.id}  uid ${p.uid}${p.included ? "  [included]" : ""}${
                    p.boundBy.length ? `  bound: ${p.boundBy.map((b) => b.name).join(", ")}` : ""
                  }`,
              )
              .join("\n") || "no kata projects",
          );
        }),
      }),

      list: cliCommand({
        summary: "List issues, sorted by priority then last update",
        options: {
          project: projectOption,
          status: { type: "enum", values: ["open", "closed", "all"], default: "open", description: "Status filter" },
          priority: { ...priorityOption, description: "Only this priority (0-4)" },
          label: { ...labelOption, description: "Only issues with this label (all must match)" },
          owner: { type: "string", aliases: ["assignee"], description: "Only issues owned by this actor" },
          unowned: { type: "boolean", description: "Only issues with no owner" },
          limit: {
            type: "integer",
            min: 1,
            max: LIST_MAX_LIMIT,
            default: LIST_DEFAULT_LIMIT,
            aliases: ["n"],
            description: `Rows to print (max ${LIST_MAX_LIMIT})`,
          },
          json: jsonOption,
        },
        constraints: [{ kind: "at-most-one", options: ["owner", "unowned"] }],
        run: ({ options }, ctx) => safe(async () => {
          const result = await service.list(scopeOf(options, ctx, "bb kata list"), {
            status: options.status as "open" | "closed" | "all",
            ...(options.priority === undefined ? {} : { priority: options.priority }),
            labels: options.label,
            ...(options.owner === undefined ? {} : { owner: options.owner }),
            unowned: options.unowned,
            limit: options.limit,
          });
          if (options.json) {
            return json({ project: result.project, issues: listJson(result.issues), total: result.total });
          }
          return out(listText(result, `no ${options.status === "all" ? "" : `${options.status} `}issues match`));
        }),
      }),

      ready: cliCommand({
        summary: "Open issues with no open blockers, by priority",
        options: {
          project: projectOption,
          label: labelOption,
          owner: { type: "string", description: "Only issues owned by this actor" },
          unowned: { type: "boolean", description: "Only issues with no owner" },
          limit: { type: "integer", min: 1, max: LIST_MAX_LIMIT, default: LIST_DEFAULT_LIMIT, description: `Rows (max ${LIST_MAX_LIMIT})` },
          json: jsonOption,
        },
        constraints: [{ kind: "at-most-one", options: ["owner", "unowned"] }],
        run: ({ options }, ctx) => safe(async () => {
          const result = await service.ready(scopeOf(options, ctx, "bb kata ready"), {
            labels: options.label,
            ...(options.owner === undefined ? {} : { owner: options.owner }),
            unowned: options.unowned,
            limit: options.limit,
          });
          if (options.json) return json({ project: result.project, issues: listJson(result.issues), total: result.total });
          return out(listText(result, "nothing is ready"));
        }),
      }),

      search: cliCommand({
        summary: "Search issues (title, body, comments), open and closed",
        positionals: [{ name: "query", description: "Search text", required: true, variadic: true }],
        options: {
          project: projectOption,
          limit: { type: "integer", min: 1, max: 100, default: 20, description: "Results (max 100)" },
          json: jsonOption,
        },
        run: ({ options, positionals }, ctx) => safe(async () => {
          const q = positionals.query.join(" ");
          const { project, hits } = await service.search(scopeOf(options, ctx, `bb kata search ${JSON.stringify(q)}`), q, options.limit);
          if (options.json) {
            return json({
              project,
              results: hits.map((h) => ({ ...h, issue: { ...h.issue, body: h.issue.body.slice(0, 1000) } })),
            });
          }
          if (hits.length === 0) return out(`${project.name}: no matches for ${JSON.stringify(q)}`);
          return out(hits.map((h) => `${issueLine(h.issue)}  (${(h.matched_in ?? []).join(", ")})`).join("\n"));
        }),
      }),

      show: cliCommand({
        summary: "Show an issue: fields, body, relations, the last 20 comments",
        positionals: [refPositional],
        options: { project: projectOption, json: jsonOption },
        run: ({ options, positionals }, ctx) => safe(async () => {
          const d = await service.show(scopeOf(options, ctx, `bb kata show ${positionals.ref}`), positionals.ref);
          return options.json ? json(detailJson(d)) : out(formatDetail(d));
        }),
      }),

      create: cliCommand({
        summary: "Create an issue; prints its qualified id (search first to avoid duplicates)",
        positionals: [{ name: "title", description: "Issue title (quote it; up to 500 characters)", required: true, variadic: true }],
        options: {
          project: projectOption,
          body: { type: "string", aliases: ["description"], stdin: true, description: "Markdown body" },
          "body-file": bodyFileOption,
          priority: priorityOption,
          parent: { type: "string", placeholder: "ref", description: "Parent issue ref (containment only)" },
          label: labelOption,
          "blocked-by": { type: "string", repeatable: true, placeholder: "ref", description: "An issue that must close first" },
          blocks: { type: "string", repeatable: true, placeholder: "ref", description: "An issue this one blocks" },
          related: { type: "string", repeatable: true, placeholder: "ref", description: "A related issue" },
          "idempotency-key": {
            type: "string",
            description: "Key (8-128 chars) that makes a retried create land once",
          },
          json: jsonOption,
        },
        constraints: [{ kind: "at-most-one", options: ["body", "body-file"] }],
        run: ({ options, positionals }, ctx) => safe(async () => {
          const key = options["idempotency-key"];
          if (key !== undefined && (key.length < 8 || key.length > 128)) {
            throw new PluginCliError("--idempotency-key must be 8-128 characters", { code: "invalid_value" });
          }
          const text = await body(options, ctx);
          const d = await service.create(
            scopeOf(options, ctx, "bb kata create \"<title>\""),
            {
              title: positionals.title.join(" "),
              ...(text === undefined ? {} : { body: text }),
              ...(options.priority === undefined ? {} : { priority: options.priority }),
              ...(options.parent === undefined ? {} : { parent: options.parent }),
              labels: options.label,
              blockedBy: options["blocked-by"],
              blocks: options.blocks,
              related: options.related,
            },
            key,
          );
          return options.json ? json(detailJson(d)) : out(d.issue.qualified_id);
        }),
      }),

      priority: cliCommand({
        summary: "Set priority 0-4 (0 highest), or - to clear",
        positionals: [refPositional, { name: "priority", description: "0-4, or - to clear", required: true }],
        options: { project: projectOption, json: jsonOption },
        run: ({ options, positionals }, ctx) => safe(async () => {
          const d = await service.setPriority(
            scopeOf(options, ctx, `bb kata priority ${positionals.ref} ${positionals.priority}`),
            positionals.ref,
            parsePriority(positionals.priority),
          );
          return mutationResult(d, options.json);
        }),
      }),

      edit: cliCommand({
        summary: "Change an issue's title and/or body",
        positionals: [refPositional],
        options: {
          project: projectOption,
          title: { type: "string", description: "New title" },
          body: { type: "string", stdin: true, description: "New markdown body, replacing the old one" },
          "body-file": bodyFileOption,
          json: jsonOption,
        },
        constraints: [
          { kind: "at-least-one", options: ["title", "body", "body-file"] },
          { kind: "at-most-one", options: ["body", "body-file"] },
        ],
        run: ({ options, positionals }, ctx) => safe(async () => {
          const text = await body(options, ctx);
          const d = await service.edit(scopeOf(options, ctx, `bb kata edit ${positionals.ref}`), positionals.ref, {
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(text === undefined ? {} : { body: text }),
          });
          return mutationResult(d, options.json);
        }),
      }),

      comment: cliCommand({
        summary: "Add a comment",
        positionals: [refPositional, { name: "text", description: "Comment text (or --body-file / --body-stdin)", variadic: true }],
        options: {
          project: projectOption,
          body: { type: "string", stdin: true, hidden: true, description: "Comment text" },
          "body-file": bodyFileOption,
          json: jsonOption,
        },
        run: ({ options, positionals }, ctx) => safe(async () => {
          const inline = positionals.text.length > 0 ? positionals.text.join(" ") : undefined;
          const fromOptions = await body(options, ctx);
          if ((inline === undefined) === (fromOptions === undefined)) {
            throw new PluginCliError("pass the comment as text or with --body-file, not both or neither", {
              code: "missing_required",
              hint: `e.g. \`bb kata comment ${positionals.ref} "what changed"\` or \`--body-file notes.md\`.`,
            });
          }
          const d = await service.comment(
            scopeOf(options, ctx, `bb kata comment ${positionals.ref}`),
            positionals.ref,
            (inline ?? fromOptions)!,
          );
          return options.json ? json(detailJson(d)) : out(`commented on ${d.issue.qualified_id} (${d.comments.length} comments)`);
        }),
      }),

      label: cliCommand({
        summary: "Add or remove a label: label <ref> add|rm <label>",
        positionals: [
          refPositional,
          { name: "op", description: "add or rm", required: true },
          { name: "label", description: "Label name", required: true },
        ],
        options: { project: projectOption, json: jsonOption },
        run: ({ options, positionals }, ctx) => safe(async () => {
          const op = positionals.op === "remove" || positionals.op === "del" ? "rm" : positionals.op;
          if (op !== "add" && op !== "rm") {
            throw new PluginCliError(`expected add or rm, got ${JSON.stringify(positionals.op)}`, {
              code: "invalid_value",
              hint: `e.g. \`bb kata label ${positionals.ref} add needs-review\`.`,
            });
          }
          const d = await service.label(
            scopeOf(options, ctx, `bb kata label ${positionals.ref} ${op} ${positionals.label}`),
            positionals.ref,
            op,
            positionals.label,
          );
          return mutationResult(d, options.json);
        }),
      }),

      close: cliCommand({
        summary: "Close verified work with a reason and a message",
        description:
          "Rules (kata daemon): --done needs a 40+ character message and at least one --evidence; --wontfix a 60+ character message; --duplicate-of / --superseded-by a 20+ character message. A parent with open children cannot close. If the work is not verified, do not close: label it needs-review and comment what remains.",
        positionals: [refPositional],
        options: {
          project: projectOption,
          done: { type: "boolean", description: "Completed and verified (needs --evidence)" },
          wontfix: { type: "boolean", aliases: ["wont-fix"], description: "Not going to be done" },
          "duplicate-of": { type: "string", placeholder: "ref", aliases: ["duplicate"], description: "Duplicate of this issue" },
          "superseded-by": { type: "string", placeholder: "ref", aliases: ["superseded"], description: "Replaced by this issue" },
          message: { type: "string", short: "m", aliases: ["reason-message", "msg"], stdin: true, description: "Why / what was done (min 40 done, 60 wontfix, 20 otherwise)" },
          evidence: {
            type: "string",
            repeatable: true,
            placeholder: "kind:value",
            description: "commit:<sha>, pr:<url>, test:<cmd>, reviewed-paths:<a,b>, external:<account> (done needs one)",
          },
          "dry-run": { type: "boolean", description: "Validate with the daemon without closing" },
          json: jsonOption,
        },
        constraints: [
          { kind: "exactly-one", options: ["done", "wontfix", "duplicate-of", "superseded-by"] },
          { kind: "requires", option: "done", needs: ["message", "evidence"] },
        ],
        run: ({ options, positionals }, ctx) => safe(async () => {
          const reason: CloseReason = options.done
            ? "done"
            : options.wontfix
              ? "wontfix"
              : options["duplicate-of"] !== undefined
                ? "duplicate"
                : "superseded";
          const result = await service.close(scopeOf(options, ctx, `bb kata close ${positionals.ref}`), positionals.ref, {
            reason,
            ...(options.message === undefined ? {} : { message: options.message }),
            ...(reason === "duplicate" ? { target: options["duplicate-of"]! } : {}),
            ...(reason === "superseded" ? { target: options["superseded-by"]! } : {}),
            evidence: options.evidence.map(parseEvidence),
            dryRun: options["dry-run"],
          });
          if (result.dryRun) {
            const id = result.issue.qualified_id ?? `${result.project.name}#${result.issue.short_id}`;
            return options.json ? json({ dryRun: true, ok: true, issue: result.issue }) : out(`dry run: ${id} would close as ${reason}`);
          }
          return mutationResult(result.detail, options.json);
        }),
      }),

      reopen: cliCommand({
        summary: "Reopen a closed issue",
        positionals: [refPositional],
        options: { project: projectOption, json: jsonOption },
        run: ({ options, positionals }, ctx) => safe(async () =>
          mutationResult(await service.reopen(scopeOf(options, ctx, `bb kata reopen ${positionals.ref}`), positionals.ref), options.json),
        ),
      }),

      link: cliCommand({
        summary: "Link this thread to an issue (shown in the thread header)",
        positionals: [refPositional],
        options: { project: projectOption, thread: threadOption, json: jsonOption },
        run: ({ options, positionals }, ctx) => safe(async () => {
          const threadId = requireThread(ctx, options.thread, `link ${positionals.ref}`);
          const { link, title } = await service.link(threadId, scopeOf(options, ctx, `bb kata link ${positionals.ref}`), positionals.ref);
          return options.json ? json({ threadId, link, title }) : out(`linked ${threadId} to ${link.qualifiedId}  ${title}`);
        }),
      }),

      unlink: cliCommand({
        summary: "Remove this thread's issue link",
        options: { thread: threadOption, json: jsonOption },
        run: ({ options }, ctx) => safe(async () => {
          const threadId = requireThread(ctx, options.thread, "unlink");
          const before = await service.unlink(threadId);
          if (options.json) return json({ threadId, unlinked: before });
          return out(before ? `unlinked ${threadId} from ${before.qualifiedId}` : `${threadId} was not linked`);
        }),
      }),

      linked: cliCommand({
        summary: "Print the issue this thread is linked to",
        options: { thread: threadOption, json: jsonOption },
        run: ({ options }, ctx) => safe(async () => {
          const threadId = requireThread(ctx, options.thread, "linked");
          const link = await service.linked(threadId);
          if (options.json) return json({ threadId, link });
          return out(link ? `${link.qualifiedId}  (issue ${link.issueUid})` : `${threadId} is not linked to a kata issue`);
        }),
      }),

      include: cliCommand({
        summary: "Show a kata project as a tab in the Kata viewer",
        positionals: [{ name: "project", description: "Kata project name, uid or id", required: true }],
        options: { json: jsonOption },
        run: ({ options, positionals }) => safe(async () => {
          const r = await service.setIncluded(positionals.project, true);
          return options.json ? json(r) : out(`included ${r.project.name}; tabs: ${r.included.join(", ") || "(none)"}`);
        }),
      }),

      exclude: cliCommand({
        summary: "Remove a kata project's tab from the Kata viewer",
        positionals: [{ name: "project", description: "Kata project name, uid or id", required: true }],
        options: { json: jsonOption },
        run: ({ options, positionals }) => safe(async () => {
          const r = await service.setIncluded(positionals.project, false);
          return options.json ? json(r) : out(`excluded ${r.project.name}; tabs: ${r.included.join(", ") || "(none)"}`);
        }),
      }),
    },
  });
}
