// Inline editors that live in the list pane: the new-issue draft row, the
// title editor, the `/` filter bar and the `l` label bar. Each owns its text
// and hands only Esc and the save chords to the panel (components/fields).
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseLabelInput } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { ROW_HEIGHT } from "@/components/issue-list";
import { FieldHint, LineInput, Textarea, fieldKeyDown, useDiscardGuard } from "@/components/fields";

export interface Draft {
  /** Parent for `N`; its row gets the draft right below it. */
  parentUid: string | null;
  title: string;
  body: string;
  showBody: boolean;
  error: string | null;
}

export function DraftRow({
  draft,
  depth,
  parentLabel,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  depth: number;
  parentLabel: string | null;
  onChange: (draft: Draft) => void;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const guard = useDiscardGuard(onCancel);
  const dirty = draft.title.trim() !== "" || draft.body.trim() !== "";

  // Layout effects: the very next keystroke must already land in the field.
  useLayoutEffect(() => {
    titleRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (draft.showBody) bodyRef.current?.focus();
  }, [draft.showBody]);

  const save = () => {
    if (draft.title.trim() === "") {
      onChange({ ...draft, error: "Title required" });
      titleRef.current?.focus();
      return;
    }
    onSave(draft);
  };
  const openBody = () => {
    if (draft.showBody) bodyRef.current?.focus();
    else onChange({ ...draft, showBody: true });
  };
  const cancel = () => guard.cancel(dirty);

  return (
    <div
      data-draft-row
      className="border-y border-primary/40 bg-primary/5 px-3 py-1"
      style={{ paddingLeft: 12 + depth * 18 }}
    >
      <div className="flex items-center gap-2" style={{ minHeight: ROW_HEIGHT - 8 }}>
        <span className="w-3 shrink-0 text-center font-mono text-xs text-primary">+</span>
        <LineInput
          ref={titleRef}
          aria-label={parentLabel ? `New child of ${parentLabel}` : "New issue title"}
          placeholder={parentLabel ? `New child of ${parentLabel}…` : "New issue title…"}
          value={draft.title}
          onChange={(event) => {
            guard.disarm();
            onChange({ ...draft, title: event.target.value, error: null });
          }}
          onKeyDown={(event) =>
            fieldKeyDown(event, "line", {
              submit: save,
              saveDraft: draft.showBody ? save : openBody,
              openBody,
              cancel,
            })
          }
        />
      </div>
      {draft.showBody ? (
        <Textarea
          ref={bodyRef}
          aria-label="New issue body"
          className="mt-1 min-h-20"
          placeholder="Body (markdown)…"
          value={draft.body}
          onChange={(event) => {
            guard.disarm();
            onChange({ ...draft, body: event.target.value });
          }}
          onKeyDown={(event) => fieldKeyDown(event, "multiline", { submit: save, cancel })}
        />
      ) : null}
      <div className="mt-0.5 flex gap-3">
        {draft.error ? (
          <FieldHint tone="error">{draft.error}</FieldHint>
        ) : guard.armed ? (
          <FieldHint tone="error">esc again to discard</FieldHint>
        ) : (
          <FieldHint>
            {draft.showBody
              ? "ctrl-o or ⌘enter to save · esc to cancel"
              : "enter to save · ⇧enter or ctrl-o to add a body · esc to cancel"}
          </FieldHint>
        )}
      </div>
    </div>
  );
}

export function TitleEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  const guard = useDiscardGuard(onCancel);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <LineInput
        ref={ref}
        aria-label="Edit title"
        value={value}
        onChange={(event) => {
          guard.disarm();
          setValue(event.target.value);
        }}
        onKeyDown={(event) =>
          fieldKeyDown(event, "line", {
            submit: () => {
              const title = value.trim();
              if (title === "" || title === initial) onCancel();
              else onSave(title);
            },
            cancel: () => guard.cancel(value.trim() !== initial),
          })
        }
      />
      {guard.armed ? <FieldHint tone="error">esc again to discard</FieldHint> : null}
    </div>
  );
}

export function FilterBar({
  value,
  autoFocus,
  focusNonce,
  onChange,
  onAccept,
  onClear,
}: {
  value: string;
  autoFocus: boolean;
  /** Bumped by `/` to focus the field again. */
  focusNonce: number;
  onChange: (value: string) => void;
  onAccept: () => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, focusNonce]);
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
      <span className="font-mono text-xs text-muted-foreground">/</span>
      <LineInput
        ref={ref}
        aria-label="Filter issues"
        placeholder="Filter title, label, id…"
        className="border-transparent bg-transparent"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => fieldKeyDown(event, "line", { submit: onAccept, cancel: onClear })}
      />
    </div>
  );
}

const MAX_SUGGESTIONS = 8;

export function LabelBar({
  issueLabel,
  current,
  known,
  onApply,
  onCancel,
}: {
  issueLabel: string;
  current: readonly string[];
  known: readonly string[];
  onApply: (change: { add: string[]; remove: string[] }) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLInputElement | null>(null);
  const guard = useDiscardGuard(onCancel);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  // Complete the token under the caret (always the last one here).
  const tokenStart = Math.max(value.lastIndexOf(" "), value.lastIndexOf(",")) + 1;
  const token = value.slice(tokenStart);
  const removing = token.startsWith("-");
  const stem = (removing ? token.slice(1) : token).toLowerCase();
  const suggestions = useMemo(() => {
    const pool = removing ? current : known.filter((label) => !current.includes(label));
    return pool.filter((label) => label.toLowerCase().includes(stem)).slice(0, MAX_SUGGESTIONS);
  }, [removing, current, known, stem]);
  const highlighted = suggestions[Math.min(active, suggestions.length - 1)];

  const complete = () => {
    if (highlighted === undefined) return false;
    setValue(`${value.slice(0, tokenStart)}${removing ? "-" : ""}${highlighted} `);
    setActive(0);
    return true;
  };
  const apply = () => {
    const change = parseLabelInput(value);
    if (change.add.length === 0 && change.remove.length === 0) onCancel();
    else onApply(change);
  };

  return (
    <div className="shrink-0 border-t border-border bg-card px-3 py-2">
      {suggestions.length > 0 ? (
        <ul className="mb-1.5 flex flex-wrap gap-1" aria-label="Label suggestions">
          {suggestions.map((label) => (
            <li
              key={label}
              className={cn(
                "rounded border px-1.5 text-[11px]",
                label === highlighted
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground",
              )}
            >
              {removing ? "−" : ""}
              {label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">Label {issueLabel}</span>
        <LineInput
          ref={ref}
          aria-label="Labels to add or remove"
          placeholder="name adds, -name removes; tab to complete"
          value={value}
          onChange={(event) => {
            guard.disarm();
            setValue(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              if (complete()) event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              const count = Math.max(1, suggestions.length);
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
              return;
            }
            fieldKeyDown(event, "line", { submit: apply, cancel: () => guard.cancel(value.trim() !== "") });
          }}
        />
      </div>
      <div className="mt-1">
        {guard.armed ? (
          <FieldHint tone="error">esc again to discard</FieldHint>
        ) : (
          <FieldHint>
            On it: {current.length > 0 ? current.join(", ") : "none"} · ↑↓ to pick · tab to complete · enter to apply
          </FieldHint>
        )}
      </div>
    </div>
  );
}
