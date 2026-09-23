import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRefs, issueDirective, parseIssueDirective, readIssueTarget, tryParseRef } from "./refs.ts";

const ULID = "01M348TF0GJTPAX1XGRC60TCZ4";
const PROJECT = "01M3475DE16AW4481B4VA2RFHX";

test("tryParseRef: forms and junk", () => {
  assert.deepEqual(tryParseRef(" grippify#06FH "), { kind: "qualified", project: "grippify", ref: "06fh" });
  assert.deepEqual(tryParseRef("06fh"), { kind: "short", ref: "06fh" });
  assert.deepEqual(tryParseRef(ULID.toLowerCase()), { kind: "uid", ref: ULID });
  for (const bad of ["", "#abc", "a b", "x#y#z", "../x", '06fh"}', "grip ify#06fh"]) assert.equal(tryParseRef(bad), null, bad);
});

test("parseIssueDirective: ref vs uid", () => {
  assert.deepEqual(parseIssueDirective({ ref: "grippify#06fh" }), {
    ok: true,
    ref: { kind: "qualified", project: "grippify", ref: "06fh" },
    label: "grippify#06fh",
  });
  assert.deepEqual(parseIssueDirective({ ref: "06fh" }), { ok: true, ref: { kind: "short", ref: "06fh" }, label: "06fh" });
  const byUid = parseIssueDirective({ uid: ULID.toLowerCase() });
  assert.equal(byUid.ok, true);
  assert.deepEqual(byUid.ok && byUid.ref, { kind: "uid", ref: ULID });
  // A valid uid wins over the ref; the ref still labels the chip while loading.
  const both = parseIssueDirective({ uid: ULID, ref: "grippify#06fh" });
  assert.deepEqual(both.ok && both.ref, { kind: "uid", ref: ULID });
  assert.equal(both.label, "grippify#06fh");
  // An invalid uid falls back to a valid ref.
  const badUid = parseIssueDirective({ uid: "nope", ref: "grippify#06fh" });
  assert.deepEqual(badUid.ok && badUid.ref, { kind: "qualified", project: "grippify", ref: "06fh" });
});

test("parseIssueDirective: junk is rejected, never thrown", () => {
  for (const attrs of [
    {},
    { ref: "" },
    { ref: "<script>alert(1)</script>" },
    { ref: "a b#c" },
    { ref: "x".repeat(500) },
    { uid: "not-a-ulid" },
    { title: "grippify#06fh" },
    JSON.parse('{"__proto__": {"ref": "grippify#06fh"}}'),
    { ref: 42 as unknown as string },
  ]) {
    const result = parseIssueDirective(attrs);
    assert.equal(result.ok, false, JSON.stringify(attrs));
    assert.ok(result.label.length <= 40);
  }
});

test("issueDirective: only clean qualified ids", () => {
  assert.equal(issueDirective("grippify#06fh"), '::kata-issue{ref="grippify#06fh"}');
  assert.equal(issueDirective('grippify#06fh"}'), null);
  assert.equal(issueDirective("06fh"), null);
});

test("extractRefs: qualified first, then ULIDs; bare ids only without either", () => {
  assert.deepEqual(extractRefs("see grippify#06fh."), ["grippify#06fh"]);
  assert.deepEqual(extractRefs("06fh"), ["06fh"]);
  assert.deepEqual(extractRefs("dwtj"), ["dwtj"]);
  assert.deepEqual(extractRefs(`fixed in ops#ab12 and ${ULID}, also cr3x`), ["ops#ab12", ULID]);
  // Short selections try words with digits first; tiny/huge words are skipped.
  assert.deepEqual(extractRefs("look at the g8ex issue"), ["g8ex", "look", "the", "issue"]);
  assert.deepEqual(extractRefs("a b"), []);
  // Long prose: bare words are ignored, qualified refs still found.
  const prose = `${"lorem ipsum dolor ".repeat(10)} bb-plugin-kata-scratch#tcz4 ${"sit amet ".repeat(10)}`;
  assert.deepEqual(extractRefs(prose), ["bb-plugin-kata-scratch#tcz4"]);
  assert.deepEqual(extractRefs("no refs here at all, just words and #hashtags and more words to exceed"), []);
  assert.ok(extractRefs("x1y2 ".repeat(5)).length <= 10);
  assert.deepEqual(extractRefs(""), []);
});

test("readIssueTarget: validates untrusted panel params", () => {
  assert.deepEqual(readIssueTarget({ issueUid: ULID.toLowerCase(), projectUid: PROJECT, qualifiedId: "scratch#tcz4" }), {
    issueUid: ULID,
    projectUid: PROJECT,
    qualifiedId: "scratch#tcz4",
  });
  assert.deepEqual(readIssueTarget({ issueUid: ULID, projectUid: PROJECT, qualifiedId: "x\ny" })?.qualifiedId, null);
  for (const bad of [null, "x", [ULID], { issueUid: ULID }, { issueUid: "x", projectUid: PROJECT }, { issueUid: ULID, projectUid: 12 }]) {
    assert.equal(readIssueTarget(bad), null, JSON.stringify(bad));
  }
});
