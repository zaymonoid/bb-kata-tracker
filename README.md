# Kata for bb

A keyboard-first viewer and editor for the local [kata](https://www.katatracker.com)
issue tracker inside bb, modelled on `kata tui`. You get one tab per kata project
you choose, the issue list on the left, and the issue detail on the right. It
updates live from the kata daemon. There is also a `bb kata` CLI and a set of
agent tools, so bb threads can work with kata issues directly.

Developer notes (file map, data flow, what was verified) are in
[PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md).

## Requirements

- bb ≥ 0.43 on a machine with `kata` installed (on `PATH` or at
  `~/.local/bin/kata`). The plugin runs in the bb server and talks to the kata
  daemon over its unix socket. No account or token is needed.
- A running kata daemon. The plugin finds it with `kata daemon locate` (or
  `KATA_SERVER`). Like any kata command, this starts the daemon on first use. After
  that, the plugin never restarts a daemon you stopped (see
  [When the daemon is down](#when-the-daemon-is-down)).

## Install

```sh
cd bb-plugin-kata
npm install --include=dev
bb plugin build
bb plugin install . --yes      # afterwards: bb plugin reload kata
```

## Using the viewer

Open **Kata** in the sidebar, or press **⌘⇧K** (palette: "Kata: open issue viewer").
The list takes keyboard focus.

- **Tabs.** Use the `+` tab to choose which kata projects appear as tabs, and
  in what order. No projects are shown until you choose some. Your choice is
  saved in the `includedProjects` setting. `[` / `]` switch tabs. Each tab keeps
  its own selection, filter and status view.
- **Reorder tabs.** Drag a tab along the strip; a bar shows where it lands, and
  the new order is saved on drop. `alt-[` / `alt-]` move the current tab
  without the mouse, and the `+` tab's arrows still work. A *visiting* tab
  (shown for an issue outside your tabs) does not move: it is not saved.
- **Status view.** `s` cycles the tab through open → all → closed. The tab shows
  an `ALL` or `CLOSED` badge. Closed and all lists are fetched when you first ask
  for them, then cached. `r` reopens any closed row.
- **Rows stay put.** When you close or reopen an issue from the panel, its row
  stays where it was (with its new status) until you leave the tab or change the
  status view. A row only jumps if the issue changes somewhere else. This
  makes `r` an undo for `x`.
- **Resizable split.** On the Kata page, drag the line between the list and the
  detail (double-click resets it). The width is kept as a share of the panel, so
  it survives a window resize, and it follows you across tabs and reloads.
- **Narrow widths.** Below 720px, which includes the thread side panel, the
  list and the detail take turns at full width. `Enter` opens the detail and
  `Esc` goes back (or use the "← Issues" button).
- **Focus.** Keys work only while the panel has focus. When it does not, the
  footer shows **Click to use the keyboard**. A thread's panel takes focus when
  you open it on purpose: from an issue chip, the palette, or the header's
  *Open Kata issues*. It does not take focus when a thread just opens, so it
  never steals the composer.
- `?` shows every binding.

### Keymap

| Group | Keys | Action |
| --- | --- | --- |
| Navigate | `j` `↓` / `k` `↑` | next / previous issue (in the detail: scroll) |
| | `g g` `home` / `G` `end` | first / last issue |
| | `pgdn` / `pgup` | page down / up |
| | `enter` | open detail (narrow: full width) |
| | `esc` | back / clear filter |
| | `[` / `]` | prev / next tab |
| | `alt-[` / `alt-]` | move tab left / right (saves the order) |
| | `?` | help |
| Create | `n` | new issue: inline row at the top. `enter` to save, `⇧enter` or `ctrl-o` to add a body, `esc` to cancel. The new issue is selected, so `!` works right away |
| | `N` | new child of the selection |
| Edit | `! 0`…`! 4` | priority P0–P4 |
| | `! -`, `! ⌫` | clear priority |
| | `e` | edit title |
| | `b` | edit body (markdown textarea; `ctrl-o` or `⌘enter` to save, `esc` twice to discard) |
| | `x` | close: `d` done, `w` wontfix, `u` duplicate of…, `s` superseded by…, with a message |
| | `X` | close as done, no dialog |
| | `r` | reopen |
| | `c` | comment |
| | `l` | labels: `name` adds, `-name` removes; `tab` to complete |
| View | `s` | cycle open/all/closed |
| | `/` | filter by title, label or short id (`enter` to keep, `esc` to clear) |
| | `v` | nested/flat |
| | `space` / `→` / `←` | expand/collapse, expand, collapse / parent |
| | `E` | expand/collapse all |
| | `y` | copy `project#abc4` |
| Thread | `L` | link to thread (thread panel) |
| Text fields | `enter` | save (one-line) |
| | `ctrl-o`, `⌘enter` | save |
| | `esc` | cancel (twice if you typed something) |

Every edit is optimistic: the list changes at once and never waits on the
network before your next key. If the daemon refuses an edit, it is rolled back
and the error is shown in the footer. For closes, the error is shown in the
close menu, which reopens.

## Threads

A thread is **kata-bound** when a `.kata.toml` (`[project] name = "…"`, as
`kata init` writes it) is found. The plugin looks in the thread's environment
directory first (a git worktree or other checkout), then in its bb project's
default source directory, and in the ancestors of each. The nearest file wins.
In a bound thread:

- The **thread header** shows the kata project, or the linked issue and its
  priority. Its menu has *Open Kata issues*, *Link issue…* and *Unlink*.
- The **"Kata issues" side panel** is the same viewer, pinned to that project.
  `L` links the selected issue to the thread.
- The agent gets short instructions (project, ref format, the linked issue),
  the `kata_*` tools and the `kata` skill.
- `::kata-issue{ref="project#abc4"}` on its own line in a message renders as a
  clickable chip. Clicking it opens the issue in the side panel. A closed issue
  opens in the *all* view. Right-click the chip for *Copy ref*. The message
  action "Kata: open issue from selection" finds refs in the text you select.
- Palette: "Kata: open issue…" (by ref) and "Kata: link issue to this thread".

## `bb kata`

Available in any bb terminal or thread. The project comes from `--project`, a
qualified ref, or the thread's binding. Every command has `--help`, and most
take `--json`.

| Command | Does |
| --- | --- |
| `projects` | kata projects, which are viewer tabs, bound bb projects |
| `list [--status open\|closed\|all] [--priority N] [--label L]… [--owner A \| --unowned] [--limit 50]` | Issues sorted by priority, then last update |
| `ready [--label L]… [--limit N]` | Open issues with no open blockers |
| `search <query…>` | Title, body and comments; open and closed |
| `show <ref>` | Fields, body, relations, last 20 comments, and the chip directive |
| `create <title…> [--body \| --body-file \| --body-stdin] [--priority] [--parent] [--label]… [--blocked-by]… [--blocks]… [--related]…` | Prints the new `project#abc4` |
| `priority <ref> <0-4\|->` | Set or clear the priority |
| `edit <ref> [--title] [--body \| --body-file]` | Change the title or body |
| `comment <ref> <text… \| --body-file \| --body-stdin>` | Add a comment |
| `label <ref> add\|rm <label>` | Add or remove a label |
| `close <ref> --done\|--wontfix\|--duplicate-of R\|--superseded-by R --message … [--evidence k:v]… [--dry-run]` | Close, following kata's rules for non-TUI closes |
| `reopen <ref>` | Reopen |
| `link <ref>` / `unlink` / `linked` | This thread's issue link |
| `include <project>` / `exclude <project>` | Add or remove a viewer tab |

## Agent tools

Kata-bound threads get these tools. They mirror the CLI and share its rules.

| Tool | Does |
| --- | --- |
| `kata_list` | List with filters; `ready: true`; `query` searches |
| `kata_show` | One issue, with the chip directive |
| `kata_create` | Create (priority, labels, parent, links) |
| `kata_update` | Priority, title, body, labels, parent |
| `kata_comment` | Comment |
| `kata_close` | Close with a reason, message and evidence; `dry_run` |
| `kata_link_thread` | Link or unlink the thread's issue |

Agents close `done` only with a 40+ character message and evidence, which is
the daemon's rule for non-TUI closes. The skill tells them to label unverified
work `needs-review` instead, and never to delete anything.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `includedProjects` | `[]` | JSON array of kata project uids shown as tabs, in order. Tab drags, `alt-[` / `alt-]`, the `+` tab and `bb kata include` / `exclude` all edit it |
| `actor` | empty | Name recorded on changes made from bb. Empty means `$KATA_AUTHOR`, then `$USER` |

## When the daemon is down

The panel shows a banner: **"kata daemon unreachable — retrying…"**. Cached
issues stay visible. Keys that would change something show an inline error
instead of failing silently. The plugin checks again every few seconds with
`kata daemon status`, which never starts a daemon. When you start the daemon
again (`kata daemon start`), the panel reconnects and reloads everything within
about 4 seconds, with no page reload. Only the very first connection after the
plugin loads uses `kata daemon locate`, which starts a stopped daemon.

## Testing against real data

Do not smoke-test mutations on real projects. Use a scratch kata project (this
repo used `bb-plugin-kata-scratch`) and reach it without adding it as a tab:
open one of its issues with "Kata: open issue…" (it shows as an unsaved,
*visiting* tab), or open a thread whose working directory has a `.kata.toml`
naming it.
