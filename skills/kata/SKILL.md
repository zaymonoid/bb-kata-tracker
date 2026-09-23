---
name: kata
description: Work with the local kata issue tracker from a bb thread — find, create, prioritize, comment on, close and link kata issues with `bb kata` or the kata_* tools. Use when a thread's project is kata-bound (.kata.toml) or the user mentions kata issues or refs like project#abc4.
---

# Kata issues from bb

kata is the user's local issue tracker. The Kata bb plugin talks to its
daemon directly: use the `kata_*` tools or `bb kata …`, not the `kata` binary.

## When a thread is kata-bound

A thread is kata-bound when its working directory (its environment: a
worktree or other checkout), else its bb project's directory, or an ancestor
of either, has a `.kata.toml` naming a kata project. In such threads the kata
tools are available and every command defaults to that project. Elsewhere, pass
`--project <name>` (tools: `project`). `bb kata projects` lists the names.

Closed issues are part of the project too: `bb kata list --status closed`
(or `all`), and `search` covers both. The user sees them in the Kata panel
with `s` (open → all → closed) and can reopen them there with `r`.

A thread can be linked to one issue (shown in its header):
`bb kata link <ref>`, `bb kata linked`, `bb kata unlink`, or the
`kata_link_thread` tool. When a thread is linked, that issue is the one you are
working on.

## Refs

- `abc4`: short id in the resolved project
- `project#abc4`: qualified; overrides the project (it must match `--project` if you pass both)
- `01M348TF0GJTPAX1XGRC60TCZ4`: the issue ULID; kata finds its project

When you mention an issue to the user, write the directive
`::kata-issue{ref="project#abc4"}` on its own line (`bb kata show` and
`kata_show` print it ready to paste); bb renders it as a clickable chip.

## Rules

1. **Search before you create.** `bb kata search <words>` (tool:
   `kata_list` with `query`) covers open and closed issues. If one exists,
   comment on it or reopen it instead of filing a duplicate.
2. **Close only verified work, always with a message.** kata enforces:
   - `--done`: a message of 40+ characters and at least one `--evidence`:
     `commit:<sha>`, `pr:<url>`, `test:<cmd>`, `reviewed-paths:<a,b>`, `external:<account>`
   - `--wontfix`: 60+ characters
   - `--duplicate-of <ref>` / `--superseded-by <ref>`: 20+ characters
   - a parent with open children cannot close
   Use `--dry-run` to check a close without doing it.
3. **Not verified? Do not close.** Add `needs-review` and comment what remains:
   `bb kata label <ref> add needs-review` then `bb kata comment <ref> "…"`.
4. **Never delete or purge** issues or projects. There is no delete command, on purpose.
5. Priority: 0 is highest, 4 lowest, unset is allowed. Parent is containment only.
   `blocks`/`blocked-by` decide what is `ready`.

## Commands

Every command takes `--project <name|uid>` where it acts on a project, and
`--json` for machine-readable output. Run `bb kata <command> --help` for all options.

```
bb kata projects                                  # names, ids, viewer tabs, bound bb projects
bb kata list [--status open|closed|all] [--priority N] [--label L]… [--owner A | --unowned] [--limit 50]
bb kata ready [--label L]… [--limit N]            # open, no open blockers
bb kata search <query…> [--limit 20]
bb kata show <ref>                                # body, relations, last 20 comments
bb kata create "<title>" [--body TEXT | --body-file PATH | --body-stdin] [--priority 0-4]
        [--parent REF] [--label L]… [--blocked-by REF]… [--blocks REF]… [--related REF]…
        [--idempotency-key KEY]                   # prints the new project#id
bb kata priority <ref> <0-4|->                    # - clears
bb kata edit <ref> [--title T] [--body TEXT | --body-file PATH]
bb kata comment <ref> <text… | --body-file PATH | --body-stdin>
bb kata label <ref> add|rm <label>
bb kata close <ref> --done --message "…" --evidence test:"npm test"
bb kata close <ref> --wontfix | --duplicate-of REF | --superseded-by REF --message "…" [--dry-run]
bb kata reopen <ref>
bb kata link <ref> | bb kata unlink | bb kata linked   # this thread (or --thread thr_…)
bb kata include <project> | bb kata exclude <project>  # tabs in the Kata viewer
```

List output is one line per issue, priority first:

```
P1 06fh  Grip sensor drifts after calibration  [bug, hw] @zaymonoid
-- k2q9  Write onboarding notes
```

`--body-file` reads from the machine the command runs on; relative paths
are resolved against the current directory. Output is capped (bodies at
20k characters, 20 comments, 500 list rows).

## Tools (kata-bound threads)

| Tool | Mirrors |
| --- | --- |
| `kata_list` | `list`, `ready` (`ready: true`), `search` (`query`) |
| `kata_show` | `show` |
| `kata_create` | `create` |
| `kata_update` | `priority`, `edit`, `label`, parent (`parent: null` detaches) |
| `kata_comment` | `comment` |
| `kata_close` | `close` (same rules; `dry_run`) |
| `kata_link_thread` | `link` / `unlink` (`ref: null`) |
