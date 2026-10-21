import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlankDraft, mergeDraft, newThreadDraft, pickBoundProject } from "./new-thread.ts";

test("newThreadDraft: one line naming the issue, title in plain quotes", () => {
  assert.equal(
    newThreadDraft({ qualified_id: "grippify#06fh", title: 'Fix the "grip" bug' }),
    'Work on kata issue grippify#06fh: "Fix the "grip" bug". Run `bb kata show grippify#06fh` for full details.',
  );
  assert.equal(
    newThreadDraft({ qualified_id: "a#b1", title: " two\nlines\t" }),
    'Work on kata issue a#b1: "two lines". Run `bb kata show a#b1` for full details.',
  );
});

test("isBlankDraft: empty and whitespace-only are blank", () => {
  assert.equal(isBlankDraft(""), true);
  assert.equal(isBlankDraft("  \n\t \n"), true);
  assert.equal(isBlankDraft(" x "), false);
});

test("mergeDraft: a blank draft becomes the line, anything else gets it as a new paragraph", () => {
  assert.equal(mergeDraft("", "LINE"), "LINE");
  assert.equal(mergeDraft(" \n\n ", "LINE"), "LINE");
  assert.equal(mergeDraft("draft", "LINE"), "draft\n\nLINE");
  assert.equal(mergeDraft("  indented\nsecond  \n\n\n", "LINE"), "  indented\nsecond\n\nLINE");
  assert.equal(mergeDraft(mergeDraft("draft", "ONE"), "TWO"), "draft\n\nONE\n\nTWO");
});

test("pickBoundProject: none, one, or the first of several with a note", () => {
  assert.equal(pickBoundProject([]), null);
  assert.deepEqual(pickBoundProject([{ id: "proj_a", name: "A" }]), { project: { id: "proj_a", name: "A" }, note: null });
  assert.deepEqual(
    pickBoundProject([
      { id: "proj_a", name: "A" },
      { id: "proj_b", name: "B" },
      { id: "proj_c", name: "C" },
    ]),
    { project: { id: "proj_a", name: "A" }, note: "also bound: B, C" },
  );
});
