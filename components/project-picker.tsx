// The project picker (the gear in the tab strip): a checklist of kata projects for one
// group at a time, always the active group. Checked projects are the group's
// projects, first and in tab order; the rest follow alphabetically. Checked
// rows are dragged to reorder, as the tabs are (a bar marks the gap, the drop
// reports a slot to `moveToSlot`), or moved with alt-j / alt-k.
//
// The header lists the groups (components/group-chips.tsx). Choosing another
// group here makes it the active group, so the strip follows; the header also
// adds, renames and deletes groups. Every edit is a new `ProjectGroups` value
// (the pure edits in lib/groups.ts) handed to `onChange`, which saves it at
// once. Keys come from `pickerKey` (lib/keymap.ts).
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { KataProject } from "@/lib/kata-types";
import {
  activateGroup,
  activeGroup,
  addGroup,
  groupsOf,
  MAX_GROUP_NAME,
  removeGroup,
  renameGroup,
  setGroupProjects,
  stepGroup,
  toggleGroupProject,
  type ProjectGroups,
} from "@/lib/groups";
import { pickerKey, type PickerCommand } from "@/lib/keymap";
import { moveToSlot, shiftBy } from "@/lib/reorder";
import { cn } from "@/lib/utils";
import { fieldKeyDown, LineInput } from "@/components/fields";
import { GroupChips } from "@/components/group-chips";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

export interface ProjectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly KataProject[] | null;
  projectsError: string | null;
  groups: ProjectGroups | null;
  /** Save edited groups. A new `activeGroupId` switches the active group. */
  onChange: (next: ProjectGroups) => void;
}

/** What the header is doing: nothing, naming a new group, renaming, or asking to delete. */
type Mode = "idle" | "new" | "rename" | "confirmDelete";

interface DragState {
  uid: string;
  /** Where the row came from, so its own gaps can be ignored. */
  from: number;
  /** The gap it would land in. */
  slot: number;
}

const keep = (event: { preventDefault: () => void }) => event.preventDefault();

export function ProjectPicker({ open, onOpenChange, projects, projectsError, groups, onChange }: ProjectPickerProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [name, setName] = useState("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const editing = groups === null ? null : activeGroup(groups);
  const editingId = editing?.id ?? null;
  const checkedUids = editing?.projectUids ?? [];
  const onlyGroup = (groups?.groups.length ?? 0) < 2;

  // The group's projects first, in tab order; the rest alphabetically.
  const ordered = projects
    ? [
        ...checkedUids
          .map((uid) => projects.find((project) => project.uid === uid))
          .filter((project): project is KataProject => project !== undefined),
        ...projects
          .filter((project) => !checkedUids.includes(project.uid))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ]
    : [];
  // Only rows that are shown count as gaps (a project kata no longer has is skipped).
  const shownChecked = ordered.filter((project) => checkedUids.includes(project.uid)).map((project) => project.uid);
  const current = ordered.find((project) => project.uid === cursor) ?? ordered[0] ?? null;

  // A header input or a pending delete belongs to the group it was started on.
  useEffect(() => setMode("idle"), [editingId, open]);

  useEffect(() => {
    if (current !== null) document.getElementById(rowId(current.uid))?.scrollIntoView({ block: "nearest" });
  }, [current?.uid]);

  const focusList = () => requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));

  const save = (next: ProjectGroups) => {
    if (groups !== null && next !== groups) onChange(next);
  };
  const toggle = (uid: string) => {
    if (groups !== null && editingId !== null) save(toggleGroupProject(groups, editingId, uid));
  };
  const reorder = (next: readonly string[]) => {
    if (groups !== null && editingId !== null && next !== shownChecked) save(setGroupProjects(groups, editingId, next));
  };
  const stopEditing = () => {
    setMode("idle");
    focusList();
  };
  const submitName = () => {
    if (groups !== null) {
      if (mode === "new") save(addGroup(groups, name));
      else if (mode === "rename" && editingId !== null) save(renameGroup(groups, editingId, name));
    }
    stopEditing();
  };

  const run = (command: PickerCommand) => {
    switch (command.type) {
      case "cursor": {
        if (ordered.length === 0) return;
        const index = current === null ? 0 : ordered.indexOf(current);
        const next = ordered[Math.min(Math.max(index + command.delta, 0), ordered.length - 1)];
        if (next !== undefined) setCursor(next.uid);
        return;
      }
      case "toggle":
        if (current !== null) toggle(current.uid);
        return;
      case "shift":
        if (current !== null) reorder(shiftBy(shownChecked, current.uid, command.delta));
        return;
      case "group":
        if (groups !== null) save(stepGroup(groups, command.delta));
        return;
      case "newGroup":
        setName("");
        setMode("new");
        return;
      case "renameGroup":
        if (editing === null) return;
        setName(editing.name);
        setMode("rename");
        return;
      case "deleteGroup":
        if (!onlyGroup) setMode("confirmDelete");
        return;
      case "confirmDelete":
        if (groups !== null && editingId !== null) save(removeGroup(groups, editingId));
        setMode("idle");
        return;
      case "cancelDelete":
        setMode("idle");
        return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    const command = pickerKey(event, { typing, confirming: mode === "confirmDelete" });
    if (command === null) return;
    event.preventDefault();
    event.stopPropagation();
    run(command);
  };

  // ---- drag to reorder (checked rows only) ----------------------------------

  const indicator =
    drag !== null && drag.slot !== drag.from && drag.slot !== drag.from + 1 ? drag.slot : null;
  const start = (event: DragEvent<HTMLElement>, uid: string) => {
    const from = shownChecked.indexOf(uid);
    if (from < 0) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", uid);
    // Drag the whole row, not just the handle.
    const row = document.getElementById(rowId(uid));
    if (row !== null) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
    setDrag({ uid, from, slot: from });
    setCursor(uid);
  };
  const over = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (drag === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const slot = event.clientY < box.top + box.height / 2 ? index : index + 1;
    setDrag((now) => (now === null || now.slot === slot ? now : { ...now, slot }));
  };
  const drop = (event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    if (drag !== null) reorder(moveToSlot(shownChecked, drag.uid, drag.slot));
    setDrag(null);
    focusList();
  };

  const bar = (edge: "top" | "bottom") => (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-foreground",
        edge === "top" ? "-top-0.5" : "-bottom-0.5",
      )}
    />
  );

  // ---- header ----------------------------------------------------------------

  const nameInput = (label: string) => (
    <LineInput
      autoFocus
      aria-label={label}
      placeholder="Group name"
      maxLength={MAX_GROUP_NAME}
      value={name}
      onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => fieldKeyDown(event, "line", { submit: submitName, cancel: stopEditing })}
      onBlur={() => setMode("idle")}
      className="h-6 w-32 flex-none text-xs"
    />
  );

  const header =
    groups === null ? null : (
      <div className="flex h-8 items-stretch gap-1 border-b border-border">
        <GroupChips
          groups={groups.groups}
          activeGroupId={groups.activeGroupId}
          onActivate={(groupId) => save(activateGroup(groups, groupId))}
          activeEditor={mode === "rename" ? nameInput("Rename group") : undefined}
          className="min-w-0 shrink overflow-x-auto"
        />
        {mode === "new" ? (
          <span className="flex shrink-0 items-center px-1">{nameInput("New group name")}</span>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={keep}
            onClick={() => run({ type: "newGroup" })}
            title="New group (n)"
            className="flex shrink-0 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Icon name="Plus" className="size-3.5" />
            new group
          </button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <span title="Rename group (e)">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              tabIndex={-1}
              onMouseDown={keep}
              aria-label="Rename group"
              onClick={() => run({ type: "renameGroup" })}
            >
              <Icon name="Edit" className="size-3.5" />
            </Button>
          </span>
          {mode === "confirmDelete" && editing !== null ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-xs"
              tabIndex={-1}
              onMouseDown={keep}
              onClick={() => run({ type: "confirmDelete" })}
            >
              Delete {editing.name}? enter / esc
            </Button>
          ) : (
            // The span carries the tooltip (Button takes no `title`, and a
            // disabled button gets no pointer events).
            <span title={onlyGroup ? "The only group cannot be deleted" : "Delete group (d)"}>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                tabIndex={-1}
                onMouseDown={keep}
                aria-label="Delete group"
                disabled={onlyGroup}
                onClick={() => run({ type: "deleteGroup" })}
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            </span>
          )}
        </span>
      </div>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusList();
        }}
        onEscapeKeyDown={(event) => {
          // Esc cancels a header input or a pending delete before it closes.
          if (mode === "idle") return;
          event.preventDefault();
          stopEditing();
        }}
      >
        <DialogHeader>
          <DialogTitle>Kata projects</DialogTitle>
          <DialogDescription>
            Checked projects are in {editing === null ? "the group" : `“${editing.name}”`} and appear as its tabs, in
            this order.
          </DialogDescription>
        </DialogHeader>
        {header}
        {projectsError ? (
          <p role="alert" className="text-sm text-destructive">
            {projectsError}
          </p>
        ) : projects === null || groups === null ? (
          <p className="text-sm text-muted-foreground">Loading projects…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The kata daemon has no projects. Run <code>kata init</code> in a repository.
          </p>
        ) : (
          <ul
            ref={listRef}
            tabIndex={0}
            aria-label={`Projects of ${editing?.name ?? "the group"}`}
            className="max-h-[60vh] space-y-0.5 overflow-y-auto outline-none"
          >
            {ordered.map((project) => {
              const uid = project.uid;
              const checked = checkedUids.includes(uid);
              const index = shownChecked.indexOf(uid);
              const others = onlyGroup ? [] : groupsOf(groups, uid).filter((group) => group.id !== editingId);
              return (
                <li
                  key={uid}
                  id={rowId(uid)}
                  data-current={uid === current?.uid || undefined}
                  onClick={() => setCursor(uid)}
                  onDragOver={checked ? (event) => over(event, index) : undefined}
                  onDrop={checked ? drop : undefined}
                  className={cn(
                    "relative flex items-center gap-2 rounded px-1 py-1",
                    uid === current?.uid ? "bg-muted" : "hover:bg-muted/50",
                    drag?.uid === uid && "opacity-50",
                  )}
                >
                  {indicator === index ? bar("top") : null}
                  {indicator === shownChecked.length && index === shownChecked.length - 1 ? bar("bottom") : null}
                  {checked ? (
                    // No `preventDefault` on mousedown: Chrome would not start the drag.
                    <span
                      draggable
                      onDragStart={(event) => start(event, uid)}
                      onDragEnd={() => setDrag(null)}
                      title="Drag to reorder (alt-j / alt-k)"
                      className="flex shrink-0 cursor-grab text-muted-foreground hover:text-foreground"
                    >
                      <Icon name="DragDropVertical" className="size-3.5" />
                    </span>
                  ) : (
                    <span aria-hidden className="size-3.5 shrink-0" />
                  )}
                  <Checkbox
                    tabIndex={-1}
                    aria-label={`${project.name} in ${editing?.name ?? "the group"}`}
                    checked={checked}
                    onMouseDown={keep}
                    onCheckedChange={() => toggle(uid)}
                  />
                  <span className="min-w-0 flex-1 cursor-default truncate text-sm" onClick={() => toggle(uid)}>
                    {project.name}
                  </span>
                  {others.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      tabIndex={-1}
                      onMouseDown={keep}
                      onClick={(event) => {
                        event.stopPropagation();
                        save(activateGroup(groups, group.id));
                      }}
                      title={`Also in ${group.name}: edit that group`}
                      className="max-w-24 shrink-0 truncate rounded bg-muted/60 px-1.5 text-[11px] leading-4 text-muted-foreground/80 hover:text-foreground"
                    >
                      {group.name}
                    </button>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

const rowId = (uid: string) => `kata-picker-${uid}`;
