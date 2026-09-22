const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  UPGRADABLE_HOSTS,
  planCoverScheme,
  isUpgradable,
  toHttps,
} = require("./cover_scheme_plan");

const work = (id, imageUrl, title = "A Book") => ({
  _id: id,
  englishTranslatedTitle: title,
  ...(imageUrl === undefined ? {} : { imageUrl }),
});

// The real shape, with the query Google Books actually returns.
const STORED =
  "http://books.google.com/books/content?id=-WlZIfnhjw8C&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api";

test("an http books.google.com cover is rewritten, scheme only", () => {
  const { rewrites, skipped } = planCoverScheme([work("1", STORED)]);
  assert.equal(skipped.length, 0);
  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0].from, STORED);
  assert.equal(
    rewrites[0].to,
    "https://books.google.com/books/content?id=-WlZIfnhjw8C&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api"
  );
  // Everything after the scheme survives byte for byte, query included.
  assert.equal(rewrites[0].to.slice("https://".length), rewrites[0].from.slice("http://".length));
});

test("a host that has not been checked is left alone", () => {
  const { rewrites, skipped } = planCoverScheme([work("1", "http://example.test/cover.jpg")]);
  assert.equal(rewrites.length, 0);
  assert.match(skipped[0].reason, /host not on the checked list/);
});

test("a lookalike host does not match the allowlist", () => {
  // `startsWith` on the string would pass this; parsing the host does not.
  for (const url of [
    "http://books.google.com.evil.test/cover.jpg",
    "http://notbooks.google.com/cover.jpg",
    "http://evil.test/?x=http://books.google.com/",
  ]) {
    assert.equal(isUpgradable(url, UPGRADABLE_HOSTS), false, url);
  }
});

test("userinfo cannot smuggle the allowed host past the check", () => {
  assert.equal(
    isUpgradable("http://books.google.com@evil.test/cover.jpg", UPGRADABLE_HOSTS),
    false
  );
});

test("already-https, missing and non-string values are skipped with a reason", () => {
  const { rewrites, skipped } = planCoverScheme([
    work("1", "https://books.google.com/a.jpg"),
    work("2", undefined),
    work("3", ""),
    work("4", null),
    work("5", 42),
    work("6", "ftp://books.google.com/a.jpg"),
  ]);
  assert.equal(rewrites.length, 0);
  assert.deepEqual(
    [...skipped.map((s) => s.reason)],
    [
      "already https",
      "no imageUrl",
      "no imageUrl",
      "no imageUrl",
      "imageUrl is number, not a string",
      "not an http(s) url",
    ]
  );
});

test("a url that does not parse is skipped rather than thrown on", () => {
  assert.equal(isUpgradable("http://", UPGRADABLE_HOSTS), false);
  const { rewrites } = planCoverScheme([work("1", "http://")]);
  assert.equal(rewrites.length, 0);
});

test("toHttps changes the scheme and nothing else", () => {
  assert.equal(toHttps("http://a.test/b?c=d#e"), "https://a.test/b?c=d#e");
});

test("the plan is a pure function of its input", () => {
  const works = [work("1", STORED)];
  const before = JSON.stringify(works);
  planCoverScheme(works);
  assert.equal(JSON.stringify(works), before);
});
