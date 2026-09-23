// Choose which kata projects appear as tabs, and their order. Every toggle
// or move is saved immediately (the `includedProjects` setting). The tabs
// themselves are also dragged to reorder (components/project-tabs.tsx); both
// move through `lib/reorder.ts`.
import type { KataProject } from "@/lib/kata-types";
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
import { shiftBy } from "@/lib/reorder";

export interface ProjectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly KataProject[] | null;
  projectsError: string | null;
  included: readonly string[];
  onChange: (next: string[]) => void;
}

export function ProjectPicker({
  open,
  onOpenChange,
  projects,
  projectsError,
  included,
  onChange,
}: ProjectPickerProps) {
  const toggle = (uid: string, checked: boolean) =>
    onChange(checked ? [...included, uid] : included.filter((other) => other !== uid));
  const move = (uid: string, delta: -1 | 1) => {
    const next = shiftBy(included, uid, delta);
    if (next !== included) onChange([...next]);
  };
  // Included projects first, in tab order; the rest alphabetically.
  const ordered = projects
    ? [
        ...included
          .map((uid) => projects.find((project) => project.uid === uid))
          .filter((project): project is KataProject => project !== undefined),
        ...projects
          .filter((project) => !included.includes(project.uid))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Kata projects</DialogTitle>
          <DialogDescription>
            Checked projects appear as tabs, in this order.
          </DialogDescription>
        </DialogHeader>
        {projectsError ? (
          <p role="alert" className="text-sm text-destructive">
            {projectsError}
          </p>
        ) : projects === null ? (
          <p className="text-sm text-muted-foreground">Loading projects…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The kata daemon has no projects. Run <code>kata init</code> in a repository.
          </p>
        ) : (
          <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto">
            {ordered.map((project) => {
              const checked = included.includes(project.uid);
              const index = included.indexOf(project.uid);
              const id = `kata-project-${project.uid}`;
              return (
                <li key={project.uid} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50">
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={(value) => toggle(project.uid, value === true)}
                  />
                  <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm">
                    {project.name}
                  </label>
                  {checked ? (
                    <span className="flex shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`Move ${project.name} left`}
                        disabled={index === 0}
                        onClick={() => move(project.uid, -1)}
                      >
                        <Icon name="ArrowUp" className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`Move ${project.name} right`}
                        disabled={index === included.length - 1}
                        onClick={() => move(project.uid, 1)}
                      >
                        <Icon name="ArrowDown" className="size-3.5" />
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
