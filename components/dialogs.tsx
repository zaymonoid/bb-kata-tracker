// The `x` close menu, the `c` comment box and the `b` body editor: small
// overlays inside the panel (not host dialogs) so focus and keys stay with
// the panel.
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { CLOSE_REASONS, CLOSE_RULES, closeProblem, type CloseReason } from "@/lib/close-rules";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/issue-bits";
import { FieldHint, LineInput, Textarea, fieldKeyDown, useDiscardGuard } from "@/components/fields";

function Overlay({
  label,
  onDismiss,
  wide = false,
  children,
}: {
  label: string;
  onDismiss: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label={label}
      onMouseDown={onDismiss}
      aria-modal="true"
      className={cn(
        "absolute inset-0 z-20 flex items-start justify-center bg-background/60 p-4 backdrop-blur-[1px]",
        wide ? "pt-8" : "pt-16",
      )}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className={cn("w-full rounded-lg border border-border bg-card p-3 shadow-lg", wide ? "max-w-2xl" : "max-w-lg")}
      >
        {children}
      </div>
    </div>
  );
}

export interface CloseValues {
  reason: CloseReason;
  message: string;
  targetRef: string;
}

export function CloseDialog({
  issueLabel,
  initial,
  error,
  onSubmit,
  onCancel,
}: {
  issueLabel: string;
  initial?: CloseValues;
  error: string | null;
  onSubmit: (values: CloseValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<CloseValues>(
    initial ?? { reason: "done", message: "", targetRef: "" },
  );
  const reasonsRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLInputElement | null>(null);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const guard = useDiscardGuard(onCancel);
  const problem = closeProblem(values.reason, values.message, values.targetRef);
  const rule = CLOSE_RULES[values.reason];

  useLayoutEffect(() => {
    // A retry after a daemon error lands in the message.
    (initial ? messageRef.current : reasonsRef.current)?.focus();
  }, []);

  const submit = () => {
    if (problem !== null) {
      (rule.target !== null && values.targetRef.trim() === "" ? targetRef.current : messageRef.current)?.focus();
      return;
    }
    onSubmit(values);
  };
  const cancel = () => guard.cancel(values.message.trim() !== "" || values.targetRef.trim() !== "");
  const pick = (reason: CloseReason) => {
    guard.disarm();
    setValues((v) => ({ ...v, reason }));
  };

  const onReasonKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLButtonElement)) return;
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.altKey) {
      fieldKeyDown(event, "multiline", { submit, cancel });
      return;
    }
    const byKey = CLOSE_REASONS.find((reason) => CLOSE_RULES[reason].key === event.key);
    const index = CLOSE_REASONS.indexOf(values.reason);
    let next: CloseReason | undefined = byKey;
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "j" || event.key === "l") {
      next = CLOSE_REASONS[(index + 1) % CLOSE_REASONS.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "k" || event.key === "h") {
      next = CLOSE_REASONS[(index + CLOSE_REASONS.length - 1) % CLOSE_REASONS.length];
    }
    if (next !== undefined) {
      event.preventDefault();
      pick(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <Overlay label={`Close ${issueLabel}`} onDismiss={cancel}>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Close {issueLabel}</h2>
      <div
        ref={reasonsRef}
        role="radiogroup"
        aria-label="Reason"
        tabIndex={0}
        onKeyDown={onReasonKey}
        className="flex flex-wrap gap-1 rounded-md p-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {CLOSE_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            role="radio"
            tabIndex={-1}
            aria-checked={values.reason === reason}
            onClick={() => {
              pick(reason);
              reasonsRef.current?.focus();
            }}
            className={cn(
              "flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs",
              values.reason === reason
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/60",
            )}
          >
            <Kbd>{CLOSE_RULES[reason].key}</Kbd>
            {CLOSE_RULES[reason].label}
          </button>
        ))}
      </div>
      {rule.target !== null ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">
            {rule.target === "duplicate-of" ? "Duplicate of" : "Superseded by"}
          </span>
          <LineInput
            ref={targetRef}
            aria-label="Target issue"
            placeholder="abc4"
            value={values.targetRef}
            onChange={(event) => {
              guard.disarm();
              setValues((v) => ({ ...v, targetRef: event.target.value }));
            }}
            onKeyDown={(event) =>
              fieldKeyDown(event, "line", { submit: () => messageRef.current?.focus(), cancel })
            }
          />
        </div>
      ) : null}
      <Textarea
        ref={messageRef}
        aria-label="Close message"
        className="mt-2 min-h-20"
        placeholder={rule.minMessage > 0 ? `Why (${rule.minMessage}+ characters)…` : "Message (optional)…"}
        value={values.message}
        onChange={(event) => {
          guard.disarm();
          setValues((v) => ({ ...v, message: event.target.value }));
        }}
        onKeyDown={(event) => fieldKeyDown(event, "multiline", { submit, cancel })}
      />
      <div className="mt-1.5 space-y-0.5">
        {error ? <FieldHint tone="error">{error}</FieldHint> : null}
        {guard.armed ? (
          <FieldHint tone="error">esc again to discard</FieldHint>
        ) : (
          <FieldHint tone={problem && values.message.trim() !== "" ? "error" : "muted"}>
            {problem ?? "Ready."} · {CLOSE_REASONS.map((r) => CLOSE_RULES[r].key).join("/")} or arrows to pick ·
            enter (on the reasons), ctrl-o or ⌘enter to close · esc to cancel
          </FieldHint>
        )}
      </div>
    </Overlay>
  );
}

export function CommentDialog({
  issueLabel,
  initial,
  error,
  onSubmit,
  onCancel,
}: {
  issueLabel: string;
  initial?: string;
  error: string | null;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial ?? "");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const guard = useDiscardGuard(onCancel);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => {
    if (body.trim() !== "") onSubmit(body);
  };
  const cancel = () => guard.cancel(body.trim() !== "");
  return (
    <Overlay label={`Comment on ${issueLabel}`} onDismiss={cancel}>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Comment on {issueLabel}</h2>
      <Textarea
        ref={ref}
        aria-label="Comment"
        className="min-h-28"
        placeholder="Markdown…"
        value={body}
        onChange={(event) => {
          guard.disarm();
          setBody(event.target.value);
        }}
        onKeyDown={(event) => fieldKeyDown(event, "multiline", { submit, cancel })}
      />
      <div className="mt-1.5 space-y-0.5">
        {error ? <FieldHint tone="error">{error}</FieldHint> : null}
        <FieldHint tone={guard.armed ? "error" : "muted"}>
          {guard.armed ? "esc again to discard" : "ctrl-o or ⌘enter to post · esc to cancel"}
        </FieldHint>
      </div>
    </Overlay>
  );
}

export function BodyDialog({
  issueLabel,
  initial,
  original,
  error,
  onSubmit,
  onCancel,
}: {
  issueLabel: string;
  /** Text to start from: the body, or the unsaved text after a failed save. */
  initial: string;
  /** The body as saved; esc discards at once when nothing differs from it. */
  original: string;
  error: string | null;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const guard = useDiscardGuard(onCancel);
  useLayoutEffect(() => {
    ref.current?.focus();
    // Start at the end, where an edit usually goes.
    const end = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(end, end);
  }, []);
  const changed = body !== original;
  const submit = () => (changed ? onSubmit(body) : onCancel());
  const cancel = () => guard.cancel(changed);
  return (
    <Overlay label={`Edit body of ${issueLabel}`} onDismiss={cancel} wide>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Body of {issueLabel}</h2>
      <Textarea
        ref={ref}
        aria-label="Issue body"
        className="min-h-64 font-mono text-[13px]"
        placeholder="Markdown…"
        value={body}
        onChange={(event) => {
          guard.disarm();
          setBody(event.target.value);
        }}
        onKeyDown={(event) => fieldKeyDown(event, "multiline", { submit, cancel })}
      />
      <div className="mt-1.5 space-y-0.5">
        {error ? <FieldHint tone="error">{error}</FieldHint> : null}
        <FieldHint tone={guard.armed ? "error" : "muted"}>
          {guard.armed
            ? "esc again to discard your changes"
            : `ctrl-o or ⌘enter to save${changed ? "" : " (nothing changed yet)"} · esc to cancel`}
        </FieldHint>
      </div>
    </Overlay>
  );
}
