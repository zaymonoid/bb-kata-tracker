// Typed HTTP client for the local kata daemon.
//
// Discovery: `KATA_SERVER` wins (a `http(s)://` base URL or `unix://` socket);
// otherwise `kata daemon locate --json` names the daemon's address (and, like
// every kata command, starts a stopped local daemon). The bb server's PATH
// may not include the kata binary, so it is looked up with `which kata`, then
// `~/.local/bin/kata`. The endpoint is cached and looked up again when a
// request fails to connect. Once a connection has worked, that lookup uses
// `kata daemon status --json`, which never starts a daemon: a daemon the
// user stopped stays stopped (the panel says so) until they start it again.
//
// Unix-socket addresses are spoken to with node:http's `socketPath`; TCP with
// fetch. Local daemons use `auth.kind = "none"`, so no token is sent.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  IssueStatusFilter,
  KataIssue,
  KataCreateIssueBody,
  KataEditIssueBody,
  KataLabelCount,
  KataMutationResponse,
  KataPollEventsResponse,
  KataProject,
  KataRawIssue,
  KataSearchHit,
  KataShowIssueResponse,
} from "./kata-types.ts";

export interface IssueListFilter {
  status?: IssueStatusFilter;
  priority?: number;
  owner?: string;
  unowned?: boolean;
  labels?: string[];
  limit?: number;
}

export type KataEndpoint =
  | { kind: "unix"; socketPath: string }
  | { kind: "tcp"; baseUrl: string };

/** An error response from the daemon (`ErrorEnvelope`). */
export class KataApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "KataApiError";
    this.status = status;
    this.code = code;
  }
}

/** The daemon could not be found or reached. */
export class KataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KataUnavailableError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const LOCATE_TIMEOUT_MS = 8_000;
/** Responses larger than this are refused rather than buffered. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "ECONNRESET",
  "EPIPE",
  "ENOTSOCK",
]);

export interface KataClientOptions {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface KataClient {
  projects(signal?: AbortSignal): Promise<KataProject[]>;
  listIssues(
    projectId: number,
    options?: IssueListFilter,
    signal?: AbortSignal,
  ): Promise<KataIssue[]>;
  /** Open issues with no open blockers (`GET .../ready`). */
  ready(projectId: number, options?: Omit<IssueListFilter, "status" | "priority">, signal?: AbortSignal): Promise<KataIssue[]>;
  search(projectId: number, q: string, options?: { limit?: number }, signal?: AbortSignal): Promise<KataSearchHit[]>;
  /** An issue by ULID in any project (`GET /issues/{uid}`). */
  issueByUid(uid: string, signal?: AbortSignal): Promise<{ issue: KataRawIssue }>;
  getIssue(
    projectId: number,
    ref: string,
    signal?: AbortSignal,
  ): Promise<KataShowIssueResponse>;
  events(
    options: { afterId: number; projectId?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<KataPollEventsResponse>;
  /** The current head of the event log (the UI snapshot's cursor). */
  eventCursor(signal?: AbortSignal): Promise<number>;
  listLabels(projectId: number, signal?: AbortSignal): Promise<KataLabelCount[]>;
  createIssue(
    projectId: number,
    body: KataCreateIssueBody,
    idempotencyKey?: string,
  ): Promise<KataMutationResponse>;
  editIssue(projectId: number, ref: string, body: KataEditIssueBody): Promise<KataMutationResponse>;
  /** `POST .../actions/{action}` (priority, close, reopen). */
  issueAction(
    projectId: number,
    ref: string,
    action: "priority" | "close" | "reopen",
    body: Record<string, unknown>,
  ): Promise<KataMutationResponse>;
  addComment(
    projectId: number,
    ref: string,
    body: { body: string; actor: string },
    idempotencyKey?: string,
  ): Promise<KataMutationResponse>;
  addLabel(
    projectId: number,
    ref: string,
    body: { label: string; actor: string },
  ): Promise<KataMutationResponse>;
  removeLabel(
    projectId: number,
    ref: string,
    label: string,
    actor: string,
  ): Promise<KataMutationResponse>;
  /** Drop the cached endpoint; the next request locates the daemon again. */
  invalidate(): void;
}

export function parseAddress(address: string): KataEndpoint | null {
  const trimmed = address.trim();
  if (trimmed.startsWith("unix://")) {
    const socketPath = trimmed.slice("unix://".length);
    return socketPath === "" ? null : { kind: "unix", socketPath };
  }
  if (/^https?:\/\//u.test(trimmed)) {
    return { kind: "tcp", baseUrl: trimmed.replace(/\/+$/u, "") };
  }
  return null;
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: LOCATE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : 127;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function findKataBinary(env: NodeJS.ProcessEnv): Promise<string | null> {
  const which = await run("which", ["kata"], env);
  const found = which.stdout.trim().split("\n")[0];
  if (which.code === 0 && found) return found;
  const fallback = join(env.HOME ?? homedir(), ".local", "bin", "kata");
  try {
    await access(fallback, constants.X_OK);
    return fallback;
  } catch {
    return null;
  }
}

/** The first running daemon's endpoint in `kata daemon status --json` output, or null. */
export function addressFromStatus(stdout: string): KataEndpoint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const daemons = (parsed as { daemons?: unknown } | null)?.daemons;
  if (!Array.isArray(daemons)) return null;
  for (const daemon of daemons) {
    const address = (daemon as { address?: unknown } | null)?.address;
    const endpoint = typeof address === "string" ? parseAddress(address) : null;
    if (endpoint !== null) return endpoint;
  }
  return null;
}

/** `locate` may start the daemon; `status` only finds a running one. */
export type DiscoveryMode = "locate" | "status";

async function locate(env: NodeJS.ProcessEnv, mode: DiscoveryMode = "locate"): Promise<KataEndpoint> {
  const override = env.KATA_SERVER?.trim();
  if (override) {
    const endpoint = parseAddress(override);
    if (endpoint === null) {
      throw new KataUnavailableError(
        `KATA_SERVER=${override} is not an http(s):// or unix:// address`,
      );
    }
    return endpoint;
  }
  const binary = await findKataBinary(env);
  if (binary === null) {
    throw new KataUnavailableError(
      "kata is not installed (not on PATH and not at ~/.local/bin/kata)",
    );
  }
  if (mode === "status") {
    const status = await run(binary, ["daemon", "status", "--json"], env);
    const endpoint = status.code === 0 ? addressFromStatus(status.stdout) : null;
    if (endpoint !== null) return endpoint;
    throw new KataUnavailableError("kata daemon is not running (start it with `kata daemon start`)");
  }
  const result = await run(binary, ["daemon", "locate", "--json"], env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const record = (parsed ?? {}) as {
    address?: unknown;
    error?: { message?: unknown };
  };
  if (result.code === 0 && typeof record.address === "string") {
    const endpoint = parseAddress(record.address);
    if (endpoint !== null) return endpoint;
  }
  const detail =
    typeof record.error?.message === "string"
      ? record.error.message
      : (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
  throw new KataUnavailableError(
    `kata daemon locate failed${detail ? `: ${detail}` : ""}`,
  );
}

function isConnectError(error: unknown): boolean {
  const code =
    (error as { code?: unknown } | null)?.code ??
    (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && CONNECT_ERRORS.has(code);
}

function toApiError(status: number, text: string): KataApiError {
  try {
    const body = JSON.parse(text) as {
      error?: { code?: string; message?: string };
    };
    if (body.error?.message) {
      return new KataApiError(
        status,
        body.error.code ?? "error",
        body.error.message,
      );
    }
  } catch {
    // fall through
  }
  return new KataApiError(status, "http_error", `kata returned HTTP ${status}`);
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function requestUnix(
  socketPath: string,
  method: string,
  path: string,
  body: string | undefined,
  signal: AbortSignal,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      accept: "application/json",
      host: "kata",
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      { socketPath, method, path, headers, signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("kata response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function requestTcp(
  baseUrl: string,
  method: string,
  path: string,
  body: string | undefined,
  signal: AbortSignal,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal,
    headers: {
      ...extraHeaders,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("kata response too large");
  }
  return { status: response.status, text: await response.text() };
}

export function query(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) search.append(key, item);
    else if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

export function createKataClient(options: KataClientOptions = {}): KataClient {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  let endpoint: Promise<KataEndpoint> | null = null;
  /** A request has succeeded: later lookups must not start a daemon the user stopped. */
  let connected = false;

  function resolveEndpoint(): Promise<KataEndpoint> {
    if (endpoint === null) {
      const pending = locate(env, connected ? "status" : "locate");
      endpoint = pending;
      pending.then(
        (found) =>
          log(
            `kata daemon at ${found.kind === "unix" ? `unix://${found.socketPath}` : found.baseUrl}`,
          ),
        () => {
          // A failed lookup is not cached; the next request tries again.
          if (endpoint === pending) endpoint = null;
        },
      );
    }
    return endpoint;
  }

  async function send<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt += 1) {
      const target = await resolveEndpoint();
      let result: { status: number; text: string };
      try {
        const bounded = withTimeout(signal);
        result =
          target.kind === "unix"
            ? await requestUnix(target.socketPath, method, path, payload, bounded, headers)
            : await requestTcp(target.baseUrl, method, path, payload, bounded, headers);
      } catch (error) {
        if (isConnectError(error)) {
          endpoint = null;
          if (attempt === 0) continue;
          throw new KataUnavailableError(
            `kata daemon is not reachable (${(error as Error).message})`,
          );
        }
        throw error;
      }
      connected = true;
      if (result.status >= 400) throw toApiError(result.status, result.text);
      return (result.text === "" ? null : JSON.parse(result.text)) as T;
    }
  }

  const api = "/api/v1";
  const issuePath = (projectId: number, ref: string) =>
    `${api}/projects/${projectId}/issues/${encodeURIComponent(ref)}`;
  const idempotency = (key: string | undefined): Record<string, string> =>
    key ? { "idempotency-key": key } : {};
  return {
    async projects(signal) {
      const body = await send<{ projects: KataProject[] | null }>(
        "GET",
        `${api}/projects`,
        undefined,
        signal,
      );
      return body.projects ?? [];
    },
    async listIssues(projectId, { status = "open", priority, owner, unowned, labels, limit } = {}, signal) {
      const body = await send<{ issues: KataIssue[] | null }>(
        "GET",
        `${api}/projects/${projectId}/issues${query({
          status: status === "all" ? "" : status,
          priority,
          owner,
          unowned: unowned || undefined,
          label: labels,
          limit,
        })}`,
        undefined,
        signal,
      );
      return body.issues ?? [];
    },
    async ready(projectId, { owner, unowned, labels, limit } = {}, signal) {
      const body = await send<{ issues: KataIssue[] | null }>(
        "GET",
        `${api}/projects/${projectId}/ready${query({ owner, unowned: unowned || undefined, label: labels, limit })}`,
        undefined,
        signal,
      );
      return body.issues ?? [];
    },
    async search(projectId, q, { limit } = {}, signal) {
      const body = await send<{ results: KataSearchHit[] | null }>(
        "GET",
        `${api}/projects/${projectId}/search${query({ q, limit })}`,
        undefined,
        signal,
      );
      return body.results ?? [];
    },
    issueByUid(uid, signal) {
      return send("GET", `${api}/issues/${encodeURIComponent(uid)}`, undefined, signal);
    },
    getIssue(projectId, ref, signal) {
      return send<KataShowIssueResponse>(
        "GET",
        `${api}/projects/${projectId}/issues/${encodeURIComponent(ref)}`,
        undefined,
        signal,
      );
    },
    async events({ afterId, projectId, limit }, signal) {
      const base =
        projectId === undefined
          ? `${api}/events`
          : `${api}/projects/${projectId}/events`;
      const body = await send<KataPollEventsResponse>(
        "GET",
        `${base}${query({ after_id: afterId, limit })}`,
        undefined,
        signal,
      );
      return { ...body, events: body.events ?? [] };
    },
    async eventCursor(signal) {
      const body = await send<{ cursor?: number }>(
        "GET",
        `${api}/ui/snapshot`,
        undefined,
        signal,
      );
      return typeof body.cursor === "number" ? body.cursor : 0;
    },
    async listLabels(projectId, signal) {
      const body = await send<{ labels: KataLabelCount[] | null }>(
        "GET",
        `${api}/projects/${projectId}/labels`,
        undefined,
        signal,
      );
      return body.labels ?? [];
    },
    createIssue(projectId, body, idempotencyKey) {
      return send("POST", `${api}/projects/${projectId}/issues`, body, undefined, idempotency(idempotencyKey));
    },
    editIssue(projectId, ref, body) {
      return send("PATCH", issuePath(projectId, ref), body);
    },
    issueAction(projectId, ref, action, body) {
      return send("POST", `${issuePath(projectId, ref)}/actions/${action}`, body);
    },
    addComment(projectId, ref, body, idempotencyKey) {
      return send("POST", `${issuePath(projectId, ref)}/comments`, body, undefined, idempotency(idempotencyKey));
    },
    addLabel(projectId, ref, body) {
      return send("POST", `${issuePath(projectId, ref)}/labels`, body);
    },
    removeLabel(projectId, ref, label, actor) {
      return send(
        "DELETE",
        `${issuePath(projectId, ref)}/labels/${encodeURIComponent(label)}${query({ actor })}`,
      );
    },
    invalidate() {
      endpoint = null;
    },
  };
}
