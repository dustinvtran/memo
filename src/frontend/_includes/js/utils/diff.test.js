/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this evaluates diff.js and pulls the global it
 * defines out of it. It is run in this realm rather than in a fresh vm
 * context so that the arrays it returns compare as arrays; a file that needs
 * globals faked for it has to use a context instead, and then compare the
 * strings that come back rather than the objects.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "diff.js"), "utf8");

const { lineDiff, diffSummary } = vm.runInThisContext(`${source}\n;Diff`);

const types = (before, after) =>
  lineDiff(before, after).map(({ type, text }) => `${symbol(type)}${text}`);

const symbol = (type) =>
  type === "added" ? "+" : type === "removed" ? "-" : " ";

test("identical text has no changes", () => {
  assert.deepEqual(types("one\ntwo", "one\ntwo"), [" one", " two"]);
  assert.deepEqual(diffSummary(lineDiff("one", "one")), {
    added: 0,
    removed: 0,
  });
});

test("an added line is reported, and the untouched ones are kept", () => {
  assert.deepEqual(types("one\nthree", "one\ntwo\nthree"), [
    " one",
    "+two",
    " three",
  ]);
});

test("a removed line is reported", () => {
  assert.deepEqual(types("one\ntwo\nthree", "one\nthree"), [
    " one",
    "-two",
    " three",
  ]);
});

test("an edited line reads as a removal and an addition", () => {
  assert.deepEqual(types("Good film.", "Great film."), [
    "-Good film.",
    "+Great film.",
  ]);
  assert.deepEqual(diffSummary(lineDiff("Good film.", "Great film.")), {
    added: 1,
    removed: 1,
  });
});

test("a wiped note is all removals", () => {
  assert.deepEqual(types("a long\nnote", ""), ["-a long", "-note"]);
});

test("a note written from nothing is all additions", () => {
  assert.deepEqual(types("", "a long\nnote"), ["+a long", "+note"]);
});

test("empty against empty is nothing at all", () => {
  assert.deepEqual(lineDiff("", ""), []);
  assert.deepEqual(lineDiff(undefined, null), []);
});

test("blank lines inside a note are kept", () => {
  assert.deepEqual(types("one\n\ntwo", "one\n\ntwo\n\nthree"), [
    " one",
    " ",
    " two",
    "+",
    "+three",
  ]);
});

test("a moved paragraph is one removal and one addition, not a rewrite", () => {
  assert.deepEqual(types("a\nb\nc", "b\nc\na"), ["-a", " b", " c", "+a"]);
});
