# Kata plugin — overview (T1–T8)

User-facing docs (install, keymap, CLI, tools, settings): [README.md](README.md).

A keyboard-first viewer and fast editor for the local [kata](https://www.katatracker.com)
issue tracker, mirroring `kata tui`: one tab per included kata project, issue
list on the left, detail on the right, kept live from kata's event log.

## What exists

- **Kata sidebar page** (`/plugins/kata/kata`): project tabs plus a `+` tab that
  opens the project picker (check projects to include them, arrows to reorder).
  Tabs are also dragged to reorder, or moved with `alt-[` / `alt-]` (T8).
  Rows show status glyph, priority chip, short id, title, labels and owner. The
  detail pane shows title, qualified id, status, priority, owner, labels, the
  markdown body, parent, children, blocked-by, blocks, related, and comments.
- **Keyboard** (while the panel has focus): `j`/`k`/arrows, `g g`/`G`,
  `Home`/`End`, `PgUp`/`PgDn`, `Enter` (detail) / `Esc` (list, or clear the
  filter), `[`/`]` (tabs), `alt-[`/`alt-]` (move the tab), `?` (help). Editing keys are listed under T2 below.
- **Palette command** "Kata: open issue viewer", default ⌘⇧K.
- **Settings**: `includedProjects` (JSON array of kata project uids, default
  `[]`, also edited by the picker) and `actor` (empty = `$KATA_AUTHOR`/`$USER`;
  recorded on every mutation).
- **RPC**: `daemon.status` (T6), `projects.list`, `included.get/set`, `issues.list`
  (`open` from the warm cache, `closed`/`all` straight from the daemon),
  `issues.get`, `labels.list`, and the T2 mutations below.
- **Live updates**: the `event-tail` service polls `GET /api/v1/events` about
  once a second from the log head. Events for included projects refetch that
  project's open list and publish `{type:"issues.changed", projectUid}` on the
  realtime channel `kata`. It also publishes `included.changed` and
  `daemon.status`.

## T2: rapid entry and prioritization

Every edit is optimistic. `lib/viewer-store.ts` patches the shown list at once
and reconciles it with the issue the RPC returns. It rolls the patch back and
shows an inline error when the mutation fails. The pure layering lives in
`lib/optimistic.ts`: server list, then confirmed issues (they win until a list
fetch shows the same revision or newer), then lingering closes, then pending
edits. Nothing waits on the network before the next key.

| Keys | Action |
| --- | --- |
| `n` | New issue: an inline row at the top of the list with the title focused. `Enter` saves; `⇧Enter`/`Ctrl-O` add a body (then `Ctrl-O`/`⌘Enter` save); `Esc` cancels (a second `Esc` if anything was typed). After saving, the placeholder row is selected and the list has focus, so `!` works at once and `n` again starts the next one. |
| `N` | New child of the selection. The draft sits right under the parent, which is expanded. Switches to nested view. |
| `! 1…4`, `! 0`, `! -`/`! ⌫` | Priority P1…P4, P0, clear. Esc or any other key cancels the chord. A priority set on a placeholder is queued until its create lands. |
| `e` | Edit the title inline (Enter saves, Esc cancels). |
| `x` | Close menu: `d` done, `w` wontfix, `u` duplicate of…, `s` superseded by…, plus a message and (for u/s) the target id. `Enter` on the reasons, `Ctrl-O`, or `⌘Enter` closes. |
| `r` | Reopen. Issues closed from the panel stay in place (✓, struck through) until you leave the tab, so `r` works as undo. |
| `c` | Comment (textarea; `Ctrl-O`/`⌘Enter` posts). Shows "sending…" in the detail until it lands. |
| `l` | Labels: `name` adds, `-name` removes, several at once separated by spaces or commas. Typeahead from `GET /projects/{id}/labels` (`↑↓` pick, `Tab` completes). |
| `y` | Copy `project#abc4` (toast). |
| `/` | Live filter on title/labels/short id within the tab; Enter keeps it and returns to the list, Esc clears. In nested view, ancestors of matches stay visible. |
| `v` | Nested / flat. |
| `Space`, `→`, `←`, `E` | Toggle, expand (or step into the first child), collapse (or go to the parent), expand/collapse all. Nested rows start collapsed; box-drawing guides as in `kata tui` (`lib/tree.ts`). |

Mutation RPCs (all resolve the actor via `resolveActor` and return
`issues.get`'s shape, `{issue, children, comments}`, so the detail cache
refreshes too):

- `issues.create({projectUid, title, body?, parentRef?, priority?, idempotencyKey})`: `Idempotency-Key` header; the parent is an initial `parent` link.
- `issues.setPriority({projectUid, ref, priority: 0..4 | null})`: `actions/priority`, or `PATCH clear_priority` for null.
- `issues.close({projectUid, ref, reason, message?, targetRef?})`: sends `source:"tui"` like `kata tui`.
- `issues.reopen`, `issues.comment` (idempotency key), `issues.addLabel`, `issues.removeLabel`, `issues.edit({title?, body?})`.

Each mutation also refreshes the server's warm cache immediately; the event
tail then publishes `issues.changed` as before.

Close rules the daemon enforces (v0.16.0, probed with `dry_run`, mirrored as
hints in `lib/close-rules.ts`): with `source:"tui"`, `done` needs no message
or evidence. `wontfix` needs a message of 60+ characters. `duplicate` and
`superseded` need 20+ characters and exactly one `duplicate-of` /
`superseded-by` evidence item naming an issue in the same project. A parent
with open children cannot be closed: the daemon's refusal rolls the row back
and reopens the menu with the message.

### Verified live (2026-09-22, scratch project `bb-plugin-kata-scratch`)

Driven from the keyboard in a headless Chromium against the running bb app,
with results checked against the daemon:

- `n` + title + Enter showed a placeholder row within about 100 ms. `!2`
  pressed before the daemon answered set P2 on the real issue.
- `N` put a child under its parent, expanded (`└─`).
- `n`→Enter→`n`→Enter→`!1` in quick succession created both issues and set
  P1 on the second.
- `⇧Enter` + body + `Ctrl-O` saved the body. The first run found a race: text typed within a frame went into the title. Fields now take focus in layout effects.
- `Esc` on a non-empty draft armed; a second `Esc` discarded it.
- `/` filter, `l` add label, `l -a -b` remove labels, `e` rename, `c`
  comment (in the daemon and in the detail pane).
- Closing the parent as wontfix while its child was open: the daemon refused;
  the row rolled back and the menu reopened with the error. After closing the
  child (`x Enter` = done): wontfix + message → `r` reopen → `x Enter` done.
- `y` put `bb-plugin-kata-scratch#cr3x` on the clipboard; `v`, `E`/`E`
  behaved as expected.
- A create, a priority change and a close done straight against the daemon
  (outside bb) appeared in the open panel within about 1 s, with no reload.

## T3: kata-aware threads

A bb project is **kata-bound** when its default source directory, or an
ancestor, has a `.kata.toml` whose `[project] name` names a kata project on
the daemon. The nearest file wins, even when it is malformed (then the
project is unbound, reason `malformed .kata.toml`).

- **Binding detection** (`lib/workspace.ts`). `bb.sdk.projects.get` gives the
  default source `{hostId, path}`. `bb.sdk.files.read({hostId, path})` reads
  each candidate `.kata.toml` up to `/`, so no `node:fs` is used on user
  paths. A missing file (`ENOENT`, "not found") means "look further up". Any
  other read error (host offline) rejects, and the last good binding is kept.
  Results are cached per bb project for 60 s (5 s after a failure). The
  `bindings` background service resolves every project at startup. It also
  subscribes to `project:changed` (`project-created`, `-deleted`,
  `-sources-changed`, `-updated`) and re-resolves that project. When a result
  changes it publishes `binding.changed`. Bound kata projects join the issue
  store's *watched* set, so their open lists stay warm and emit
  `issues.changed` even when they are not tabs.
- **Reuse (T4)**: `createBindingResolver({ sdk: () => bb.sdk, kataProjects })`
  has `forProject(bbProjectId)`, `forThread(threadId)` and a synchronous
  `peek(bbProjectId)`. `readThreadLink(metadata)` validates the link. Both
  are re-exported from `server.ts`. None of them need RPC.
- **Thread ↔ issue link**: this plugin's thread metadata namespace holds
  `{ issueUid, qualifiedId, projectUid }`. `readThreadLink` checks every
  field on read: ULIDs for the uids, and `name#shortid` for the qualified id,
  with no spaces or newlines. Anything else reads as "not linked".
- **RPC**:
  - `binding.forProject({projectId})` → `{kataProject: {id,uid,name} | null, tomlName, reason}`
  - `binding.forThread({threadId})` → the same, plus `projectId` and
    `link: {issueUid, qualifiedId, projectUid, title, status, priority} | null`.
    The link is filled in from the warm list or `getIssue`, and its fields
    are null when the issue cannot be read.
  - `thread.linkIssue({threadId, projectUid, ref})` resolves `ref` against
    the daemon, then stores the link. `thread.unlinkIssue({threadId})`
    removes the three keys. Both publish `{type:"thread.link", threadId}`
    and return `binding.forThread`'s shape.
- **Thread header control** (`experimental_threadHeaderAction`,
  `components/thread-header.tsx`). One 28px button: the kata icon plus the
  project name, or the linked `project#abc4` plus its priority chip. On a
  compact viewport it shows only the icon. It renders nothing for unbound
  projects. The popover shows the linked issue (status, id, priority,
  title) and has these actions: *Open Kata issues* (`openThreadPanel`),
  *Link issue…* (typeahead over the project's open issues: `↑↓`/`Ctrl-N/P`,
  `Enter`, `Esc`) and *Unlink*. State lives in the component through
  `hooks/useThreadBinding.ts`, so each split pane has its own. It refetches
  on `thread.link`, `binding.changed`, `issues.changed` for the linked
  project, and after a reconnect.
- **Thread panel "Kata issues"** (`threadPanelAction` id `issues`, flush
  layout, `components/thread-issues-panel.tsx`). It is the same `KataPanel`
  with a `scope` prop `{projectUid, linkedIssueUid, onLink}`. That hides the
  tab strip and the picker, and pins the project in the frontend store
  (`pinProject`, reference-counted) so `applyIncluded` does not drop its
  list. All T2 keys work. The linked issue is preselected and its row is
  marked `linked`. **`L`** links the selected issue to the thread (in the nav
  page it only shows a hint). The scoped panel does not take focus on mount
  (it would steal it from the composer when a thread opens); click into it.
- **Agent instructions** (`bb.agents.configure`, synchronous, uses `peek`).
  For bound projects it returns `{tools: [], skills: [], instructions}`,
  about 500 characters: the project name, the `project#abc4` ref format, the
  linked issue as JSON-quoted data (with its title when the server has seen
  it since the last reload), "search before creating, never delete/purge",
  and "run `bb kata --help`". For unbound projects it returns `{tools: [],
  skills: []}` and no instructions. A project that has never been resolved
  gets nothing on that turn, and `peek` starts the resolution for the next
  one. The startup warm-up makes this rare.

### Verified live (2026-09-22)

- `binding.forProject`: grippify (`proj_qhs2dhik2z`) → kata `grippify`
  (id 5). Work (`proj_kdpkfeeh2h`) → null, `no .kata.toml`. Signup →
  `utilityonhome-signup`. Personal → null, `project has no source directory`.
- `binding.forThread` on the grippify thread `thr_ahr9syjp6g` → bound,
  `link: null`.
- Headless Chromium against the running app, on grippify (read only): the
  header shows `grippify` (28px). The popover lists the four actions.
  *Open Kata issues* opened the thread panel with grippify's 3 open issues
  and no tab strip, and `j` moved the selection. A Work thread shows no
  control. No console errors.
- Mutations used a temporary bb project whose directory held a `.kata.toml`
  naming `bb-plugin-kata-scratch`, plus a thread in it. Both were deleted
  afterwards. Its first turn's system prompt carried the Kata block, which
  the agent quoted back word for word. Header *Link issue…* → typing →
  `Enter` linked `bb-plugin-kata-scratch#tcz4`, and the control changed to
  the id + P2. The panel opened with that issue preselected and marked.
  Header *Unlink* cleared it. `L` in the panel linked it again. The metadata
  read back through `binding.forThread` with title/status/priority. The
  server log showed `configure` returning the linked line
  (`This thread is linked to kata issue "bb-plugin-kata-scratch#tcz4"`). The
  scratch issue was closed afterwards.
- Caveat seen live: the Claude Code session keeps the instructions it was
  built with. After linking, later turns in the same session still had the
  old (unlinked) block, even after `bb thread stop`. A new thread gets the
  current block. This is host behaviour ("instructions apply when the session
  is next constructed"), not something the plugin controls.

## T4: `bb kata` CLI, agent tools, skill

One service (`lib/kata-service.ts`) backs both the CLI and the agent tools.
It talks to the daemon through the same client, uses the T3 binding resolver
directly (no RPC), and records `resolveActor()` on every mutation. Pure
pieces live in `lib/cli-core.ts` and are unit tested: ref parsing, project
precedence, request bodies, close rules, and formatting.

- **Project resolution** (every project-scoped command and tool):
  `--project <name|uid|id>`, then the ref's own project (`project#abc4`, or a
  ULID looked up with `GET /api/v1/issues/{uid}`), then `ctx.threadId`'s
  binding, then `ctx.projectId`'s binding. If a qualified ref disagrees with
  `--project`, the command fails with `project_conflict`. If nothing resolves,
  it fails with `PluginCliError project_required`, and the hint names the
  exact `--project` flag and lists every kata project.
- **Refs**: `abc4`, `project#abc4`, or a ULID in any case. The daemon receives
  the short id or ULID, never the qualified form (it 404s on that path).
- **Output** is bounded. Lists hold at most 500 rows (fetched up to 2000,
  then sorted by priority and last update, then cut). Bodies stop at 20k
  characters, `show` has at most 20 comments, and list/search JSON clips
  bodies to 1000. Text is also cut at `PLUGIN_CLI_OUTPUT_MAX_BYTES` minus
  16 KiB. JSON over that limit is refused with a hint to lower `--limit`.
  Agent tool results stop at 64 KiB.
- **`--body-file`** reads the file on the machine that invoked the command:
  the thread's environment host, else the server machine. Relative paths
  resolve against `ctx.cwd`. The read goes through `bb.sdk.files`, never
  `node:fs`. `--body-stdin` / `--message-stdin` come from the SDK's `stdin`
  option.
- **Close rules for agents** (no `source:"tui"`; probed with `dry_run` on
  v0.16.0, in `lib/close-rules.ts` `AGENT_MIN_MESSAGE` and `closeBody`):
  `done` needs a 40+ character message and at least one evidence item
  (`commit:<sha>`, `pr:<url>`, `test:<cmd>`, `reviewed-paths:<a,b>`,
  `external:<account>`). `wontfix` needs 60+ characters, and
  duplicate/superseded need 20+ plus their target. These are checked before
  the request, so the error carries the exact rule plus the "label
  needs-review and comment" hint. The daemon's own refusals, such as "parent
  has open children", pass through as `kata_validation` errors.
- **`--dry-run`** exists only on `close`. The daemon **ignores `dry_run` on
  `reopen`**: a dry-run probe really reopened an issue, which was then closed
  again.

| Command | Does |
| --- | --- |
| `projects [--json]` | kata projects: name, id, uid, `[included]`, bound bb projects |
| `list [--status open\|closed\|all] [--priority N] [--label L]… [--owner A \| --unowned] [--limit 50] [--json]` | `P2 abc4  title  [labels] @owner`, sorted by priority then update |
| `ready [--label L]… [--owner A \| --unowned] [--limit N]` | open, unblocked (`GET .../ready`) |
| `search <query…> [--limit 20]` | daemon search (open and closed), with `matched_in` |
| `show <ref> [--json]` | fields, ids, body, parent/children/blocked by/blocks/related, last 20 comments |
| `create <title…> [--body \| --body-file \| --body-stdin] [--priority] [--parent] [--label]… [--blocked-by]… [--blocks]… [--related]… [--idempotency-key]` | prints the new qualified id. `--blocked-by X` is an incoming `blocks` link |
| `priority <ref> <0-4\|->` | `actions/priority`, or `PATCH clear_priority` |
| `edit <ref> [--title] [--body \| --body-file]` | `PATCH` |
| `comment <ref> <text… \| --body-file \| --body-stdin>` | |
| `label <ref> add\|rm <label>` | |
| `close <ref> --done\|--wontfix\|--duplicate-of R\|--superseded-by R --message … [--evidence k:v]… [--dry-run]` | rules above |
| `reopen <ref>` | |
| `link <ref>` / `unlink` / `linked` `[--thread thr_…]` | the thread↔issue metadata from T3 (same `set`/`remove` path as the RPC, publishes `thread.link`) |
| `include <project>` / `exclude <project>` | viewer tabs (`includedProjects`, same path as `included.set`) |

Every command takes `--help`, and every one except `projects`, `include` and
`exclude` takes `--json`. The failure envelope comes from the SDK. Kata
errors map to `PluginCliError`: codes `kata_<daemon code>` and
`kata_unavailable`, and a 404 gets a hint.

- **Agent tools** (`lib/agent-tools.ts`, zod params, `presentation` labels):
  `kata_list` (filters, `ready: true`, `query` → search), `kata_show`,
  `kata_create`, `kata_update` (priority/null, title, body,
  add/remove labels, parent ref/null → `links_delta`), `kata_comment`,
  `kata_close` (same rules, `dry_run`), and `kata_link_thread` (`ref: null`
  unlinks). Errors come back as `isError` text with the hint.
- **`configure`**: kata-bound threads get all seven tools, the `kata` skill,
  and the instruction block. The block now names the tools and `bb kata
  --help` and states the close discipline (about 800 characters). Unbound
  threads get nothing.
- **Skill** `skills/kata/SKILL.md` (93 lines) covers when a thread is bound,
  ref formats, search before creating, the close discipline and daemon
  rules, needs-review, never delete, every command's usage line, and the
  tool↔command table.
- The RPC `thread.linkIssue` now calls the service's `link`, and
  `included.set` shares `setIncluded` with the CLI.

### Verified live (2026-09-22)

- `npm run typecheck`, `npm test` (86 pass, 18 of them new in
  `lib/cli-core.test.ts` / `lib/cli.test.ts`, which drive the real
  `defineCli` parser against a recording fake client), `bb plugin build`,
  `bb plugin reload kata`. `bb plugin list` shows the plugin running with
  `command: bb kata`.
- `bb kata --help`, `bb kata list --help`, `bb kata close --help` and
  `bb kata create --help` print full option help, including the rules.
- From an unbound thread (Personal): `bb kata projects` lists 8 projects,
  with grippify and utilityonhome-signup shown as bound. `bb kata list`
  without `--project` fails with the `--project` hint, and `--json` gives the
  envelope. Read-only on grippify: `list`, `list --status all --limit 5`
  (with the "… 7 more" note), `show --project grippify 06fh`,
  `show grippify#g8ex`, `search`, `ready`.
- Mutations, all on `bb-plugin-kata-scratch`:
  - `create` with `--priority`, `--label a,b`, `--parent`, `--blocked-by`
    and `--body` printed `…#d0w0`. The same `--idempotency-key` a second
    time returned the same id.
  - `priority` 0 / `-` / 1 (the last with a qualified ref).
  - `comment` inline, with `--body-file` (absolute path, and relative to
    the cwd), and with `--body-stdin`.
  - `label add needs-review` / `label rm cli`, and `edit --title --body`.
  - `close --wontfix` with a 46-character message was refused locally with
    the 60-character rule. `--dry-run` was accepted. Closing the parent
    while its child was open was refused by the daemon. Then a wontfix
    close, `reopen`, `--done` without evidence (refused), and `--done`
    with `--evidence test:…`.
- `link`, `linked` (text and `--json`), `unlink`, and `linked` again from
  this thread. The refactored `thread.linkIssue` / `thread.unlinkIssue` RPCs
  still work.
- `include` / `exclude bb-plugin-kata-scratch` (the second `include` is a
  no-op), plus an unknown project name, which gives a hint. The
  `includedProjects` list was not `[]` when testing started: it held 5
  projects, apparently chosen in the panel. It was left exactly as found.
- A throwaway bb project whose root had a `.kata.toml` naming the scratch
  project, plus one thread in it: the agent listed all seven
  `kata_*` tools (as `mcp__bb-bridge__kata_*`). It called `kata_list`
  (`status: all`, `limit: 5`) and `kata_show ypd1` with no `project`, so
  the binding resolved it. Thread and project were deleted afterwards.
- Every scratch issue is closed again.

### Not verified live

- `kata_create`, `kata_update`, `kata_comment`, `kata_close` and
  `kata_link_thread` called by an agent. They share the service with the
  CLI paths verified above, but their zod → service mapping has no unit
  tests.
- Whether the agent session actually received the `kata` skill (only
  the tools and instructions were checked).
- `--body-file` from a thread on a remote host.
- Cross-project link refs on create (`--blocks other#abcd`) are sent as-is
  for the daemon to resolve.

## T5: issue links

The SDK has no hook that decorates plain text in assistant messages
(`richText.effects` is for the composer only; `experimental_contentScript`
would mean editing host DOM). So issue links reach bb in two supported ways:
the `::kata-issue` directive, and a message action for refs in prose.

- **Directive** `::kata-issue{ref="grippify#06fh"}` (`messageDirective`,
  `components/issue-chip.tsx`). It also takes `ref="06fh"` (resolved against the
  message's bb project binding, or the thread's when the message has no
  project) and `uid="<ULID>"`. A valid `uid` wins over `ref`, and the `ref` is
  still the label while the chip loads. Attributes are untrusted:
  `parseIssueDirective` (`lib/refs.ts`) checks lengths and ref shapes, and
  ignores unknown keys and prototype keys. The chip shows the status glyph,
  the priority chip, `project#abc4` and the title (struck through when
  closed). While loading it shows the ref; when unresolved it shows the ref
  muted with a tooltip (`not found`, or the reason). It is a leaf directive,
  so it must be on its own line.
  - Click opens the thread panel action `issues` with `params: { issueUid,
    projectUid, qualifiedId }`. The tab title is `Kata · project#abc4`, so the
    same issue refocuses its tab and a different issue opens a sibling tab.
    Where the host declines (no side panel), it falls back to the nav page.
  - Right-click (Radix context menu, vendored `components/ui/context-menu.tsx`):
    *Open in Kata panel*, *Copy ref*.
- **RPC `issues.resolve({refs[1..10], projectId?, threadId?})`** →
  `{issue: {uid, projectUid, projectName, shortId, qualifiedId, title, status,
  priority, blocked} | null, reason}`. The first ref that resolves wins. It
  checks the server's warm open lists first, then makes at most 4 daemon
  lookups (`getIssue`, or `GET /issues/{uid}` for ULIDs). Bare ids need a
  kata-bound thread or project. Client cache (`hooks/useResolvedIssue.ts`):
  one request per ref and scope, shared by every chip. A project's entries are
  dropped on its `issues.changed` signal (batched in a microtask), so chips
  update live. "Not found" answers expire after 30 s; failed calls are not
  cached. At most 500 entries.
- **Thread panel `params`**: `ThreadIssuesPanel` reads them with
  `readIssueTarget` (ULIDs checked, `qualifiedId` optional). It shows the
  target's project even when that is not the thread's binding (cross-project
  chips, unbound threads), preselects the issue (the target wins over the
  linked issue), and `L` still links. If the target is not in the open list,
  the status line says so ("… is not open; this panel lists open issues only").
- **Nav page targets**: `requestNavIssue` (viewer store `navTarget`, used
  once). An included project's tab is activated. Any other project becomes a
  *visiting* tab: italic, with a tooltip, not saved to `includedProjects`, and
  dropped when you switch to another tab.
- **Message action** `open-issue` "Kata: open issue from selection"
  (`messageAction`). It appears in the assistant text-selection menu and in
  every message's action bar. `extractRefs` looks for qualified refs, then
  ULIDs. Only when neither is present does it try bare words of 3–8
  characters (words with a digit first), and only in selections of up to 12
  words. It sends up to 10 candidates to `issues.resolve` with the thread id.
  From the action bar (no selection) it searches the whole message text.
  Nothing found: a toast "No kata ref in selection" (or "…in message"), with
  the failure reason when the text had a qualified ref or ULID.
- **Palette** (`app.commands.register`): "Kata: open issue…" opens a dialog
  (`components/command-dialogs.tsx`) that takes a ref and resolves it with the
  current thread or project. In a thread it opens the thread panel;
  elsewhere, the nav page. "Kata: link issue to this thread" reuses the T3
  typeahead (`LinkPicker`, now exported). Its `isAvailable` hides it outside
  threads.
- **Sidebar badge**: a count of open issues on the Kata sidebar row
  (`navPanel.experimental_sidebarAccessory`). **Removed in T8**, with its
  reducer, its RPC and the count on the `issues.changed` signal. The per-tab
  counts in the panel are unrelated and stay (they come from the lists the
  panel already holds, `viewer-store.openCounts`).
- **Agent adoption**: the configure block has one more sentence (write
  `::kata-issue{ref="project#abc4"}` on its own line when mentioning an
  issue), and `skills/kata/SKILL.md` has a matching paragraph.
  `bb kata show` prints `mention in chat as: ::kata-issue{ref="…"}`, and
  `--json` / `kata_show` JSON include `directive`. Both come from
  `issueDirective`, which only emits a clean `project#abc4`.
- **Shared refs**: `lib/refs.ts` (no zod, no Node APIs) now owns ref parsing.
  `cli-core.parseRef` wraps it and throws the same `KataUsageError`.

### Verified live (2026-09-22)

- `npm run typecheck`, `npm test` (96 pass; new: `lib/refs.test.ts`,
  `lib/badge.test.ts`, and a directive-formatting case in
  `lib/cli-core.test.ts`), `bb plugin build`, `bb plugin reload kata`, and
  `bb plugin list` (running).
- RPC: `issues.resolve` on a qualified ref, a bare id with and without a
  binding, a cross-project ref, junk, a missing short id, and a
  first-that-resolves list. `issues.openCounts` matched `bb kata list` for
  each included project.
- A temporary bb project whose `.kata.toml` named `bb-plugin-kata-scratch`,
  with a thread in it, and the scratch issue `#e8xf` ("T5 chip test"),
  checked in headless Chromium against the running app:
  - An assistant message rendered chips for `ref="project#id"`, bare
    `ref="e8xf"`, `uid=`, and the cross-project `grippify#06fh` (P2, read
    only). `#zzzz` rendered muted with the tooltip "not found", and
    `<b>junk</b>` rendered muted as literal text. A directive written inline
    in a sentence stays literal, as the host documents.
  - Clicking a chip opened `Kata · bb-plugin-kata-scratch#e8xf` with e8xf
    selected. The grippify chip opened a sibling tab on grippify with 06fh
    selected. Right-click showed both items. *Copy ref* put the ref on
    the clipboard, with a toast.
  - Selection menu: selecting `e8xf` in prose and choosing the action
    switched the panel to e8xf. Selecting "scratch" gave the no-ref toast.
    The action-bar button on a message holding the directive opened e8xf.
  - Palette "Kata: open issue…": in the thread, `nope#zzzz` showed an inline
    error and `grippify#g8ex` opened a new tab with g8ex selected. On the root
    page, `bb-plugin-kata-scratch#e8xf` went to `/plugins/kata/kata` with that
    tab active and e8xf selected. `katha#czmp` added an italic visiting tab
    with czmp selected, which was gone after switching tabs.
    `includedProjects` was unchanged.
  - "Kata: link issue to this thread": the typeahead, then Enter, linked
    e8xf (toast, header control, and `bb kata linked`). The command is not
    listed outside a thread.
  - A new thread asked a plain question ("which open kata issue is in this
    project?"). The agent answered with `::kata-issue{ref="bb-plugin-kata-scratch#e8xf"}`
    without being told to, which shows the instruction works.
  - The sidebar showed `48`, the sum over the included projects. After
    closing `#e8xf` with the CLI (done + evidence), it showed `47` and the
    chip was struck through, with no reload. (The badge is gone as of T8.)
    When the panel mounted on the now-closed target, it showed the "not open"
    hint.
  - No console errors. The thread, project and directory were deleted, and
    the scratch issue is closed.
- `includedProjects` changed during this session, and not from here: at the
  start it had 5 projects, and by the first browser check
  `bb-plugin-kata-scratch` had been appended. No RPC, CLI or UI action in
  this session set it, and the test threads made no tool calls. It was left
  as found.

### Not verified live

- Chip keyboard access to the context menu (the context-menu key or
  Shift+F10). Only the mouse was tested.
- The nav-page fallback when a chip is clicked in a chat with no side panel
  (for example a `ThreadChat` embedded in a plugin panel). The same code
  path was covered through the palette outside a thread.

## T6: polish

- **Status view** (`s`, `lib/viewer-store.ts` `setStatusView` / `cycleStatusView`,
  `STATUS_CYCLE` open → all → closed). The view is kept per tab. Server lists
  are cached per project and view (`listKey`). The open list is always loaded,
  because it feeds the tab counts (`openCounts`), peer titles and targets.
  Closed and all lists come from `issues.list` the first time a view is shown,
  and are refetched with the open list on `issues.changed`. The tab strip
  shows an `ALL` / `CLOSED` badge, and the thread panel shows it in the footer.
  `n` in the closed view switches the tab to open first. A chip, palette or
  selection target that is missing from the open list switches that tab to
  *all* and selects the issue. This replaces the T5 "not open" hint.
- **Rows stay in place** (`lib/optimistic.ts`). `reconcile` takes the
  `StatusView`. Closes *and* reopens made from the panel now linger at their
  row index, shown with their new status, until the tab or view is left. The
  entry is refreshed with the freshest copy on every pass. It is dropped early
  only when the issue leaves a list that had already shown it as it is now
  (`seen`), which means it changed elsewhere. This matters in the *all* view:
  the refetch after a reopen returns the issue first (newest), and without the
  lingering entry the row would jump. A confirmed issue is dropped only when
  both the open list and the shown list reflect it, so switching views never
  shows a stale server copy.
- **Body editing**: `b` opens `BodyDialog` (`components/dialogs.tsx`). It is a
  wide monospace textarea. `Ctrl-O` / `⌘Enter` saves. `Esc` discards at once
  when nothing changed, otherwise it needs two presses. The save goes through
  `editBody` → `issues.edit({body})`, optimistically. A failure reopens the
  dialog with your text and the error.
- **Help and keymap** (`lib/keymap.ts`): the groups are now Navigate / Create /
  Edit / View / Thread / In text fields. A test checks that every single key
  the list claims is listed.
- **Environment-first binding** (`lib/workspace.ts`). The pure pieces are
  `projectSource`, `threadSources(environment, project)` (the environment
  directory first, skipped when it is the project source) and
  `resolveFromSources(sources, readOnHost)` (the first source with a hit wins,
  and the nearest file per source). `forThread` reads the thread's
  `environmentId`, then `bb.sdk.environments.get` → `{hostId, path}`, and
  looks there first (`forEnvironment`, with its own 60 s / 5 s cache). It falls
  back to `forProject`, including when the environment cannot be read.
  `peekThread(projectId, environmentId)` backs `bb.agents.configure`.
  `Binding.origin` says where the file came from. Environment-bound kata
  projects join the watched set too.
- **Narrow layout** (`NARROW_PX = 720`, measured with a ResizeObserver on the
  panel root). The list and the detail take turns at full width. `Enter` shows
  the detail and `Esc` returns. The hidden pane stays mounted (`hidden`), so
  scroll and selection survive, and a layout effect moves focus to whichever
  pane is shown. Commands whose editors live in the list (`n`, `N`, `e`, `l`,
  `/`) switch back to it first. A click on a row in narrow mode opens the
  detail. The detail has a "← Issues" button.
- **Daemon down.** `daemon.status` RPC (`store.availability()`) is read on
  mount and revalidate, because signals only report changes. The banner reads
  "kata daemon unreachable — retrying…". Keys in `MUTATING` flash an inline
  error instead of trying. When the daemon comes back, `revalidate` runs as
  before (lists, projects and daemon status). Two backend changes:
  - `lib/kata-client.ts`: the first connection still uses `kata daemon
    locate`, which starts a stopped daemon. After any successful request,
    rediscovery uses `kata daemon status --json` (`addressFromStatus`), which
    never starts one. Before this change, `kata daemon stop` was undone within
    about 1 s by the plugin's own re-locate, and the panel never showed the
    daemon as down.
  - The tail's retry backoff is capped at 4 s (was 15 s), so a restarted
    daemon is picked up within about 4 s.
- **Focus and a11y.** `wantsFocus` remembers that focus belonged to the panel.
  When a view or tab swap unmounts the focused list, focus is parked on the
  root (`parkFocus`) or recovered from `<body>`, then handed back to the list
  once it renders. A thread panel takes focus only after a deliberate open:
  `requestScopedFocus()` from `openIssue` (chips, palette, selection action)
  and from the header's *Open Kata issues*. The header popover skips its
  close-autofocus in that case. The request is honoured within 3 s. When
  focus is outside the panel, the footer shows a **Click to use the keyboard**
  button, and the list/detail focus rings only show while the panel has focus.
  The tab count has an `aria-label`, and overlays are `aria-modal`. A scan
  found no buttons without a name in the panel.

### Measured (headless Chromium, 1400×900, largest included tab utilityon-property-portal: 25 open, 22 rows nested)

Key press dispatched on the focused list → the next frame (rAF + task),
median / p90. "sync" is the handler plus the React commit.

| | before T6 | after T6 |
| --- | --- | --- |
| tab switch (`]`, cached) | 12.8 / 14.6 ms (sync 0.5) | 14.1 / 15.6 ms (sync 0.7) |
| `j`/`k` | 12.7 / 19.7 ms (sync 0.6) | 16.9 / 19.8 ms (sync 0.7) |
| `j`/`k` in the *all* view (48 rows) | n/a | 13.2 / 19.3 ms (sync 0.6) |
| `s` → all (cached after first fetch) | n/a | sync 3.4 ms, 29 ms to paint |

Every key lands within a frame or so. The spread comes from frame alignment,
not work. The largest list in any included project is 65 rows (ops, *all*
view), far below the ~300-row threshold, so the list is **not virtualized**.

### Verified live (2026-09-22)

- `npm run typecheck`, `npm test` (110 pass; new tests for status views and
  lingering in `lib/optimistic.test.ts`, the resolver in
  `lib/workspace.test.ts`, help coverage in `lib/keymap.test.ts`, and
  `lib/kata-client.test.ts`), `bb plugin build`, `bb plugin reload kata`, and
  `bb plugin list` (running).
- A temporary bb project whose source directory had no `.kata.toml`, and a
  thread in it whose environment was an unmanaged directory holding a
  `.kata.toml` naming `bb-plugin-kata-scratch`. `binding.forThread` → scratch,
  while `binding.forProject` → unbound "no .kata.toml". The thread header
  showed scratch.
- Thread side panel (539px wide, so narrow), all on scratch: *Open Kata issues*
  from the header put focus on the list. `s` cycled open → all → closed →
  open, with the footer badge. `Enter` showed the full-width detail with focus,
  and `Esc` came back. In the *all* view, `r` reopened `tcz4` / `e8xf`, and the
  row stayed at its index before and after the refetch. `b` + text + `Ctrl-O`
  saved the body (seen in the detail). `b`, typing, then `Esc` needed a second
  `Esc`. `x Enter` closed the issue again. `?` listed the six groups. Moving
  focus to the composer showed "Click to use the keyboard", and clicking it
  focused the list.
- Nav page (read-only on real projects): ⌘⇧K focused the list. `s` / `s`
  showed `ALL` then `CLOSED` on grippify, and the view survived `]` / `[`.
  At a 900px viewport the panel went narrow, and `Enter` / `Esc` worked. The
  tabs and `includedProjects` were unchanged.
- The palette "Kata: open issue…" with the closed `bb-plugin-kata-scratch#e8xf`
  opened a visiting tab in the *all* view with e8xf selected. In the *closed*
  view, `r` on `ypd1` kept its row, shown open, and `x` closed it again. The
  visiting tab went away after `]`.
- Daemon: `kata daemon stop` → the banner appeared about 1 s later. `n` was
  refused with "kata daemon unreachable — edits are paused…" and no draft
  opened. `kata daemon start` → the banner was gone about 4 s later (8 s
  before the backoff cap). `s` then loaded the *all* list, with no reload. No
  console errors in any run, apart from the expected RPC 500s while the daemon
  was down.
- Every scratch issue is closed again. The temporary thread and project and
  both directories were deleted.

### The T2 HTTP 500 (not chased)

kata keeps no HTTP log: `daemon.log` is empty, and `kata daemon logs` only
covers hook runs. The plugin log had rotated past T2. What T6 did show is that
any RPC handler that throws reaches the browser as **HTTP 500** from bb's
plugin RPC route. For example, `issues.list` for a closed/all view while the
daemon was down returned 500, and the panel showed the error with *Retry*. The
lone T2 500 fits a transient daemon error during a mutation or `issues.get`.
It did not recur in T2–T6. No fix was made.

## T7: no web UI links, key-hint copy

- **The kata web UI is gone from the plugin.** Removed: the detail header's
  "kata web ↗" button, the chip context-menu item, the thread header popover
  item, the `o` binding (keymap, help overlay, tests), the RPCs
  `issues.webUrl` / `projects.webUrl`, `lib/issue-open.ts`'s `openInKataWeb`,
  and the client's `launchTarget` (with `KataLaunchTarget`). `bb kata show`
  never printed a web URL. Nothing opens `openUrl` any more, so the panel no
  longer takes a navigator (`components/kata-panel.tsx`).
- **Key hints follow one pattern**: `<key>: <verb phrase>` or
  `<key> to <verb>` — key first, key names lowercase (`esc`, `enter`,
  `ctrl-o`, `⌘enter`, `⇧enter`; letter keys keep their case: `b`, `N`, `!`),
  an imperative verb, and no trailing full stop. `BINDING_GROUPS` labels in
  `lib/keymap.ts` are terse noun or imperative phrases with no articles and no
  filler (`next issue`, `new child`, `collapse / parent`); the overlay renders
  the keys beside them, and the README keymap table matches. One key per row
  where the labels differ (`pgdn` / `pgup`, `[` / `]`, `! 1…4` / `! 0`). Two
  rows would both read `save`, so the one-line-field row is `save (one-line)`:
  the overlay keys its `<li>` by label. The keymap test maps DOM key names to
  the displayed lowercase names. Empty states and flash messages follow the
  same rule (`No open issues · n: new issue · s: show closed`, `r: reopen`).

## T8: drag to reorder tabs, no sidebar badge

- **Tabs are dragged to reorder** (`components/project-tabs.tsx`, native HTML5
  drag and drop, no new dependency). A tab is `draggable`; `dragover` on a tab
  picks the gap from the pointer's half of it, and a 2px bar marks that gap.
  The bar is a zero-width `<span>` holding an absolutely positioned line, so
  showing it moves no tab. Gaps either side of the dragged tab are no-ops and
  draw no bar. On drop the strip reports `(uid, slot)` to `onMove`, and the
  panel saves `moveToSlot(included, uid, slot)` through `setIncluded` →
  `included.set` — the same path as the picker's arrows. `setIncluded` already
  applies the new order to the store before the RPC and rolls back on failure,
  so the strip does not flicker or refetch (`applyIncluded` keeps the cached
  lists). The `+` tab and a *visiting* tab (T5, not in `includedProjects`) are
  neither draggable nor drop targets; the visiting tab always sits last, and it
  owns the trailing gap so a drop before it still lands at the end.
- **Keyboard parity**: `alt-[` / `alt-]` move the current tab
  (`{type:"moveTab"}`). These are the only modified keys `handleKey` claims, so
  the check sits ahead of the "never claim Ctrl/Meta/Alt" rule. macOS rewrites
  `key` under Option (`“`, `‘`), so `moveTabKey` reads the physical
  `code` (`BracketLeft` / `BracketRight`) when the caller reports one, and
  `KeyInput` gained an optional `code`. Plain `[` / `]` still switch tabs. On
  the visiting tab the footer says `visiting tab · not saved`; at either end
  nothing moves and nothing is saved. The help overlay and the README keymap
  list `move tab left` / `move tab right`.
- **Pure helper** `lib/reorder.ts`: `moveTo(order, uid, index)`,
  `moveToSlot(order, uid, slot)` (gaps counted in the list as it is now) and
  `shiftBy(order, uid, delta)`. Each returns the array it was given when
  nothing moves, so a caller can skip the save. The picker's arrows now use
  `shiftBy` instead of their own swap. Unit tests in `lib/reorder.test.ts`.
- **The sidebar badge is gone.** Removed: `components/sidebar-badge.tsx`,
  `lib/badge.ts` (and its test), the `experimental_sidebarAccessory` on the nav
  panel, the RPC `issues.openCounts`, and `openCount` on the `issues.changed`
  signal — nothing else read it (the panel's per-tab counts come from the lists
  it already has). `issue-store`'s `onIssuesChanged` is back to
  `(projectUid) => void`. `store.peekOpen` stays: `issues.resolve` uses it.

### Verified live (2026-09-23)

- `npm run typecheck`, `npm test` (113 pass: `lib/reorder.test.ts` is new, the
  three badge tests are gone, and `lib/keymap.test.ts` covers the Alt chords),
  `bb plugin build`, `bb plugin reload kata`, `bb plugin list` (running).
- Headless Chromium at 1400×900 on the nav page, with the real tab strip:
  - Dragging `ops` onto the left of `grippify` faded the dragged tab to 50%,
    drew the bar in the leading gap, and dropped `ops` first. `included.get`
    matched the strip, and the order survived a page reload. `[` / `]` still
    switched tabs afterwards.
  - `alt-]` then `alt-[` moved the active tab right and back; a third `alt-[`
    at the left end changed nothing and saved nothing. bb does not claim
    Alt+bracket, so the `⌘⇧[` fallback was not needed. The help overlay lists
    `move tab left alt-[` / `move tab right alt-]`.
  - With a visiting `katha` tab (palette "Kata: open issue…" on
    `katha#czmp`): the tab is `draggable="false"` and italic, `alt-[` on it
    said `visiting tab · not saved` and saved nothing, dragging over it left
    the bar in the gap before it, and a drop there put `ops` last among the
    saved tabs.
  - The picker's arrows (now `shiftBy`) still reorder.
  - The Kata sidebar row reads `Kata` with no number. No console errors.
- `includedProjects` was restored to the order found at the start
  (grippify, utilityonhome-signup, voice-agent-playground, ops,
  utilityon-property-portal, bb-plugin-kata-scratch) and `diff`s clean against
  the copy taken before the work. Note `bb kata projects` lists by kata id and
  only marks `[included]`; the tab order is read with `included.get`.
- **Found and fixed while testing**: the tab buttons called `preventDefault`
  on `mousedown` (so a click would not take focus from the list). Chrome then
  never fires `dragstart`, and the first drag did nothing. The tabs no longer
  prevent that default; `onActivate` and the drop call `focusList()` instead,
  so a click or a drop still leaves the keyboard on the list.

## T9: resizable split, focus on open, inset row highlight

- **The nav page's list/detail boundary is dragged** (`components/kata-panel.tsx`,
  pointer events, no new dependency). A 4px hit area holding a 1px line, cursor
  `col-resize`, the line turning `primary` on hover and while dragging.
  `pointerdown` calls `preventDefault` (a plain click would hand focus to the
  panel root) and captures the pointer, so a drag that leaves the panel keeps
  working; the element focused before the drag is refocused at the end. A
  double-click resets to 45%. The handle renders only where the split exists:
  the nav page in the wide layout. Narrow (`NARROW_PX`) and the thread side
  panel are unchanged — the panes still take turns at full width there.
- **Durable, as a fraction** (`lib/split.ts`, pure and unit tested).
  `clampFraction(fraction, panelWidth)` applies the minima (list ≥ 280px,
  detail ≥ 320px) at the panel's current width, so the same stored fraction is
  honoured at any window size and neither pane collapses; a panel too narrow to
  hold both minima splits by their ratio, and junk falls back to the default.
  `fractionFromPointer` maps the pointer to the boundary, `listWidthPx` and
  `sameFraction` compare what is rendered, and `readFraction` guards anything
  read back from storage.
- **Stored server-side**: RPC `layout.get` / `layout.set` (`{surface: "nav"}`)
  over `bb.storage.kv` (`layout.split.nav`), so the split follows the user
  across browser tabs and reloads. `localStorage` (`kata.split.nav`) mirrors it
  for the first paint; the RPC answer wins unless a drag beat it
  (`splitTouched`). The key is per surface: only the nav page has one today.
- **The nav page takes the keyboard when it opens.** Its `KataPanel` claims
  focus on mount, again on the next frame and after 150ms (the host moves focus
  during a route change), and again when the list first has rows. It never
  takes focus that is already inside the panel or in a text field. A scoped
  (thread) panel does not claim focus at all — T6's rule stands, so the
  composer is safe.
- **Row highlight**: list rows are `mx-1 … rounded-md px-2` instead of `px-3`,
  so the selection and hover background sit clear of the pane border and have
  the same rounding. The text position and the 32px row height are unchanged
  (the 4px margin replaces 4px of padding). The scroller adds `py-1`, so the
  first row's highlight does not sit flush against the tab strip. Both surfaces
  get it.

### Verified live (2026-09-23, headless Chromium 1600×1000)

- `npm run typecheck`, `npm test` (121 pass; `lib/split.test.ts` is new),
  `bb plugin build`, `bb plugin reload kata`, `bb plugin list` (running, no
  handler errors).
- Nav page: dragging the handle moved the list 576 → 830px with the keyboard
  still on the list. A reload kept 830px; clearing `localStorage` and reloading
  again still gave 830px, so the value came from the server. At a 1400px
  viewport the list was 700 of 1080px — the same 0.648 fraction — and at 1200px
  the minimum detail (320px) took over, with the fraction unharmed on the way
  back. Dragging past either end stopped at 280px and at 960px (1280 − 320).
  Double-click put it back to 576px (0.45, in `localStorage` and in
  `layout.get`). `j`, `k`, `n` + `esc` all worked afterwards, with focus back
  on the list and no issue created.
- Focus: navigating to `/plugins/kata/kata` fresh put focus on the list and `j`
  moved the selection with no click. Clicking **Kata** in the sidebar from the
  home page did the same, as did ⌘⇧K with the home composer focused. The
  grippify thread's side panel (639px, narrow) still had no handle and left
  focus on `<body>`.
- Below 720px the nav page goes narrow and the handle is gone; widening brings
  it back.
- No console errors from the plugin (bb's own environment-status 409s on the
  grippify thread are unrelated). `includedProjects` is unchanged.

## File map

| Path | Role |
| --- | --- |
| `server.ts` | Factory: settings, kata client, issue store, RPC handlers, tail service |
| `lib/kata-client.ts` | Daemon discovery (`KATA_SERVER` → `which kata` → `~/.local/bin/kata`, `kata daemon locate --json`), HTTP over unix socket / fetch, re-locate on connect errors |
| `lib/kata-types.ts` | Zod schemas + types for projects, issues, peers, comments; raw envelopes |
| `lib/issue-detail.ts` | Folds `showIssue` (labels, links, children, comments) into the list's issue shape |
| `lib/issue-store.ts` | Per-included-project open-issue cache and the event tailer |
| `lib/rpc-contract.ts` | `defineRpcContract` shared by server and app (type-only in the app) |
| `lib/signals.ts` | Realtime channel + signal types (zod-free for the app bundle) |
| `lib/keymap.ts` | Pure key/chord state machine, text-field key gating (`inputKey`), help binding table |
| `lib/viewer-store.ts` | Module-level frontend store: every included list stays cached; optimistic mutations |
| `lib/optimistic.ts` | Pure reconcile of server list + confirmed + lingering + pending edits |
| `lib/tree.ts` | Pure nested/flat rows with box-drawing guides, filter, orphan handling |
| `lib/close-rules.ts` | Close reasons and the daemon's message/evidence rules (zod-free) |
| `lib/labels.ts` | `l` input grammar |
| `app.tsx` | `navPanel`, thread header action, thread panel action, palette command, navigator bridge overlay |
| `components/kata-panel.tsx` | Panel orchestration: data, realtime, focus, keys, commands |
| `components/editors.tsx` | Draft row, inline title editor, filter bar, label bar |
| `components/dialogs.tsx` | Close menu, comment box, body editor (`b`) |
| `components/fields.tsx` | Field key hand-over, two-step Esc discard guard, inputs |
| `components/{issue-list,issue-detail,project-tabs,project-picker,help-overlay,issue-bits}.tsx` | UI pieces |
| `components/ui/*`, `lib/utils.ts`, `lib/portal-scope.ts`, `hooks/` | Vendored bb shadcn source |
| `lib/workspace.ts` | `.kata.toml` parse, ancestor search, binding resolver (cache, `peek`), thread-link validation, agent instructions |
| `hooks/useThreadBinding.ts` | Per-component thread binding state + realtime refresh |
| `components/thread-header.tsx` | Thread header control, popover, link typeahead |
| `components/thread-issues-panel.tsx` | "Kata issues" thread panel (scoped `KataPanel`) |
| `components/ui/popover.tsx` | Vendored from the `@bb` registry (desktop-v0.43.3) |
| `lib/*.test.ts` | `node --test` units: keymap, tree, optimistic, labels, issue-detail, issue-store, workspace, cli-core, cli, refs, reorder, split, kata-client |
| `lib/cli-core.ts` | Pure: refs, project precedence, list/create/close request bodies, evidence, formatting, byte bounding |
| `lib/kata-service.ts` | Operations shared by CLI and tools (resolution, daemon calls, thread link, viewer tabs) |
| `lib/cli.ts` | `defineCli` spec for `bb kata` |
| `lib/agent-tools.ts` | `kata_*` agent tools |
| `skills/kata/SKILL.md` | Agent-facing conventions and command reference |
| `lib/refs.ts` | Pure: ref parsing, `::kata-issue` attribute validation, ref extraction from text, panel-param targets, directive text |
| `lib/reorder.ts` | Pure tab-order moves (drag slot, keyboard shift), shared by the strip and the picker |
| `lib/split.ts` | Pure list/detail split maths: clamping to the pane minima, pointer → fraction, stored-value guard |
| `lib/issue-open.ts` | Open an issue (thread panel params → nav fallback), the React bridge, palette dialog store |
| `hooks/useResolvedIssue.ts` | Shared `issues.resolve` cache with realtime invalidation |
| `components/issue-chip.tsx` | `::kata-issue` directive chip and its context menu |
| `components/command-dialogs.tsx` | Palette "open issue…" / "link issue" dialogs (app overlay) |
| `components/ui/context-menu.tsx`, `menu-item-hover.tsx` | Vendored from the `@bb` registry (desktop-v0.43.3) |

## How to run

```sh
npm install --include=dev
npm run typecheck           # tsc
npm test                    # node --test lib/*.test.ts
bb plugin build
bb plugin install . --yes   # first time; afterwards: bb plugin reload kata
bb plugin rpc call kata projects.list
bb plugin logs kata
```

## Known gaps

- Peer titles for links outside the cached lists (for example closed
  blockers) show only the qualified id. Opening such a peer only shows a hint.
- The event log is polled, not streamed over SSE. Cross-project link status
  changes refresh only when the owning project emits an event.
- No list virtualization. The largest list today is 65 rows. Revisit past
  about 300 rows (IssueList renders every row; rows are memoized and 32px).
- Closed and all lists are capped at 2000 rows by the server (`truncated`).
- Rows closed or reopened from the panel stay where they are until you leave
  the tab or change the status view. That is deliberate (stable rows, `r` as
  undo), but a long session can leave closed rows in the open view.
- No removing a parent, blocks, related, owner or assignment from the panel.
- A lingering closed parent keeps its children nested under it. Once you
  leave the tab, the children of a closed parent become roots.
- Create does not pass `force_new`. If kata's look-alike soft block refuses a
  title, the draft comes back with the daemon's message and nothing is lost,
  but you can only get past it by changing the title.
- Pending comments live in panel state, so a comment still in flight is not
  shown after a remount; the comment itself still posts.
- The first connection after the plugin loads still uses `kata daemon
  locate`, which starts a stopped daemon, as every kata command does. Only
  later reconnects respect a stopped daemon.
- An RPC handler failure shows in the browser as HTTP 500 (bb's RPC route).
  The panel shows the message, but the console logs a failed request.
- T3: the linked issue's title appears in agent instructions only after the
  server has read it (the header or panel did, or a link was made) since the
  last plugin reload. The id itself is always there.
- T6: agent instructions use `peekThread`. On a thread's very first turn the
  environment may not be resolved yet, so a thread bound *only* through its
  environment's `.kata.toml` gets the block from its second turn on. Opening
  the thread (header control) usually resolves it first. `binding.forThread`
  does not report `origin` to the UI.
- T4: `bb kata` peer lines for blockers show only the qualified id (the
  daemon's `showIssue` links carry no titles).
- T4: agents cannot close `done` without evidence. This is the daemon's rule
  for non-TUI closes, and it is deliberate.
- T5: plain `project#abc4` text in messages is not turned into links (there
  is no SDK hook for that). Use the directive or the selection action.
- T5: clicking a chip whose tab is already open only refocuses that tab
  (identical params). If you moved the selection inside it, the chip does not
  select the issue again.
- T5: each different issue opened from chips gets its own tab (the host keys
  tabs by params). That is deliberate, but the tabs can pile up.
- `bb plugin list` counts handler errors, including the RPC 500s from the
  daemon-down test, so the count is above T5's 3.
- A thread panel opened by the host without a deliberate action (for example,
  restored on reload) does not take focus. Click it, or use the footer
  button.
