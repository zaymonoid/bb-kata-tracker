// One tab per included kata project, plus `+` for the project picker.
//
// Tabs are dragged to reorder (native HTML5 drag and drop): a bar marks the
// gap the tab would land in, and the drop reports the gap to `onMove`, which
// saves the new order. The `+` tab and a *visiting* tab (not in
// `includedProjects`) are neither draggable nor drop targets. `alt-[` /
// `alt-]` do the same from the keyboard (lib/keymap.ts).
import { useState, type DragEvent } from "react";
import type { KataProject } from "@/lib/kata-types";
import type { StatusView } from "@/lib/viewer-store";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface ProjectTabsProps {
  included: readonly string[];
  projects: readonly KataProject[] | null;
  activeUid: string | null;
  /** A non-included project shown for a target (not saved). */
  visiting?: string | null;
  counts: Readonly<Record<string, number | undefined>>;
  /** Status view per tab; closed/all show a badge. */
  statuses?: Readonly<Record<string, StatusView>>;
  onActivate: (uid: string) => void;
  onOpenPicker: () => void;
  /** Drop `uid` into the gap at `slot` (`lib/reorder.ts` `moveToSlot`). */
  onMove?: (uid: string, slot: number) => void;
}

interface DragState {
  uid: string;
  /** Where the tab came from, so its own gaps can be ignored. */
  from: number;
  /** The gap it would land in, or null while it is over nothing droppable. */
  slot: number | null;
}

export function ProjectTabs({
  included,
  projects,
  activeUid,
  visiting = null,
  counts,
  statuses = {},
  onActivate,
  onOpenPicker,
  onMove,
}: ProjectTabsProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const nameOf = (uid: string) =>
    projects?.find((project) => project.uid === uid)?.name ?? uid.slice(-6);
  // A visiting tab is not saved, so it neither moves nor accepts a drop.
  const movable = (uid: string) => onMove !== undefined && uid !== visiting;
  const saved = included.filter((uid) => uid !== visiting);
  const visitingShown = visiting !== null && included.includes(visiting);
  /** The gap a tab owns: its index among the saved tabs (a visiting tab sits in the last gap). */
  const slotOf = (uid: string) => (uid === visiting ? saved.length : saved.indexOf(uid));
  // Hide the bar for a drop that would change nothing.
  const indicator =
    drag !== null && drag.slot !== null && drag.slot !== drag.from && drag.slot !== drag.from + 1
      ? drag.slot
      : null;

  const start = (event: DragEvent<HTMLButtonElement>, uid: string) => {
    const from = saved.indexOf(uid);
    if (from < 0) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", uid);
    setDrag({ uid, from, slot: from });
  };
  const over = (event: DragEvent<HTMLButtonElement>, index: number) => {
    if (drag === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const slot = event.clientX < box.left + box.width / 2 ? index : index + 1;
    setDrag((current) => (current === null || current.slot === slot ? current : { ...current, slot }));
  };
  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (drag !== null && drag.slot !== null) onMove?.(drag.uid, drag.slot);
    setDrag(null);
  };

  const bar = (slot: number) => (
    <span key={`gap-${slot}`} aria-hidden className="relative w-0 shrink-0">
      <span className="absolute inset-y-1 -left-px w-0.5 rounded-full bg-foreground" />
    </span>
  );

  return (
    <div
      role="tablist"
      aria-label="Kata projects"
      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border px-2"
    >
      {included.flatMap((uid) => {
        const active = uid === activeUid;
        const count = counts[uid];
        const status = statuses[uid] ?? "open";
        const draggable = movable(uid);
        const slot = slotOf(uid);
        const tab = (
          <button
            key={uid}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={-1}
            draggable={draggable}
            onDragStart={draggable ? (event) => start(event, uid) : undefined}
            onDragOver={draggable ? (event) => over(event, slot) : undefined}
            onDrop={draggable ? drop : undefined}
            onDragEnd={draggable ? () => setDrag(null) : undefined}
            // No `preventDefault` on mousedown here: Chrome would not start the
            // drag. `onActivate` hands focus back to the list instead.
            onClick={() => onActivate(uid)}
            title={uid === visiting ? "Not an included project; shown for this issue" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm",
              uid === visiting && "italic",
              drag?.uid === uid && "opacity-50",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {nameOf(uid)}
            {count === undefined ? null : (
              <span className="text-xs text-muted-foreground" aria-label={`${count} open`}>
                {count}
              </span>
            )}
            {status === "open" ? null : (
              <span
                title={status === "closed" ? "Showing closed issues (s to cycle)" : "Showing open and closed issues (s to cycle)"}
                className="rounded border border-border px-1 text-[10px] uppercase leading-4 tracking-wide text-muted-foreground"
              >
                {status}
              </span>
            )}
          </button>
        );
        return indicator === slot ? [bar(slot), tab] : [tab];
      })}
      {indicator === saved.length && !visitingShown ? bar(indicator) : null}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Choose kata projects"
        title="Choose kata projects"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpenPicker}
        className="flex shrink-0 items-center px-2 text-muted-foreground hover:text-foreground"
      >
        <Icon name="Plus" className="size-4" />
      </button>
    </div>
  );
}
