/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this evaluates review_template.js and pulls the
 * global it defines out of it. The module touches nothing else, so it needs
 * no context of its own.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "review_template.js"),
  "utf8"
);

const { initialReviewText } = vm.runInThisContext(`${source}\n;ReviewTemplate`);

test("a new game note starts from the template", () => {
  const text = initialReviewText("games", undefined);

  assert.match(text, /^Summary paragraph here\.\n/);
  ["__Writing.__", "__Gameplay.__", "__Visuals & Audio.__"].forEach(
    (heading) => assert.ok(text.includes(`\n${heading}\n`), heading)
  );
  [
    "__Details I like:__",
    "__Details I'm ambivalent about:__",
    "__Details I don't like:__",
  ].forEach((heading) =>
    assert.ok(text.includes(`${heading}\n\n+ N/A`), heading)
  );
  assert.ok(text.trimEnd().endsWith("## Resources and Miscellanea"));
});

test("a game note with nothing in it gets the template too", () => {
  const template = initialReviewText("games", undefined);

  assert.equal(initialReviewText("games", ""), template);
  assert.equal(initialReviewText("games", "\n\n  \n"), template);
  assert.equal(initialReviewText("games", null), template);
});

test("a note that has been written in is left exactly as it is", () => {
  assert.equal(initialReviewText("games", "Loved it."), "Loved it.");
  // Whitespace around a real note is the user's, not ours to trim.
  assert.equal(initialReviewText("games", "  Loved it.\n"), "  Loved it.\n");
});

test("the other types still start from a blank note", () => {
  ["films", "books", "tv"].forEach((type) => {
    assert.equal(initialReviewText(type, ""), "");
    assert.equal(initialReviewText(type, undefined), "");
    assert.equal(initialReviewText(type, "Loved it."), "Loved it.");
  });
});
