/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads api_tokens.js into a vm context and
 * reads the `ApiTokens` global back off it — the same trick as
 * utils/conversions.test.js.
 *
 * The file restates rules the API owns, so the tests that matter most are the
 * ones holding the copy to the original: `src/api/utils/api_token.js` needs
 * nothing but `node:crypto`, so it can be imported here with no install.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "api_tokens.js"), "utf8");

const load = () => {
  const context = vm.createContext({});
  vm.runInContext(`(() => {\n${source}\n})()`, context);
  return context.ApiTokens;
};

const ApiTokens = load();

const api = () => import("../../../../api/utils/api_token.js");

const NOW = Date.parse("2026-09-29T12:00:00Z");
const DAY = 24 * 3600 * 1000;

test("the name limit is the API's", async () => {
  const { MAX_API_TOKEN_NAME_LENGTH } = await api();
  assert.equal(ApiTokens.MAX_NAME_LENGTH, MAX_API_TOKEN_NAME_LENGTH);
});

test("every lifetime offered is one the API accepts", async () => {
  const { MAX_API_TOKEN_LIFETIME_SECONDS } = await api();
  for (const { seconds } of ApiTokens.LIFETIMES) {
    if (seconds === null) continue;
    assert.ok(Number.isInteger(seconds) && seconds > 0, `${seconds} is a positive integer`);
    assert.ok(seconds <= MAX_API_TOKEN_LIFETIME_SECONDS, `${seconds} is within the cap`);
  }
});

test("the first lifetime offered is the API's default, never", () => {
  assert.equal(ApiTokens.LIFETIMES[0].seconds, null);
});

test("lifetimeOf reads a select value back, and an unknown one as never", () => {
  assert.equal(ApiTokens.lifetimeOf("30d"), 30 * 24 * 3600);
  assert.equal(ApiTokens.lifetimeOf("never"), null);
  assert.equal(ApiTokens.lifetimeOf("forever-and-a-day"), null);
  assert.equal(ApiTokens.lifetimeOf(undefined), null);
});

test("a name is trimmed before it is measured, as the parser does", () => {
  assert.equal(ApiTokens.whyNotATokenName("claude"), undefined);
  assert.equal(ApiTokens.whyNotATokenName("  claude  "), undefined);
  assert.match(ApiTokens.whyNotATokenName(""), /name/);
  assert.match(ApiTokens.whyNotATokenName("   "), /name/);
  assert.match(ApiTokens.whyNotATokenName(undefined), /name/);
  assert.equal(ApiTokens.whyNotATokenName("x".repeat(64)), undefined);
  assert.match(ApiTokens.whyNotATokenName("x".repeat(65)), /64/);
  assert.equal(ApiTokens.whyNotATokenName(` ${"x".repeat(64)} `), undefined);
});

test("isExpired agrees with the API's on every case the list can hold", async () => {
  const { isExpired: apiIsExpired } = await api();
  const cases = [
    { expiresAt: null }, // never expires, or minted before the field existed
    { expiresAt: NOW + DAY },
    { expiresAt: NOW - DAY },
    { expiresAt: NOW }, // the instant itself is expired
  ];
  for (const token of cases) {
    assert.equal(ApiTokens.isExpired(token, NOW), apiIsExpired(token, NOW), JSON.stringify(token));
  }
  assert.equal(ApiTokens.isExpired({ expiresAt: NOW }, NOW), true);
  assert.equal(ApiTokens.isExpired({ expiresAt: null }, NOW), false);
});

test("forDisplay puts working tokens first, newest first, and leaves its argument alone", () => {
  const tokens = [
    { id: "old", createdAt: NOW - 90 * DAY, expiresAt: null },
    { id: "expired-new", createdAt: NOW - 5 * DAY, expiresAt: NOW - DAY },
    { id: "new", createdAt: NOW - DAY, expiresAt: NOW + DAY },
    { id: "expired-old", createdAt: NOW - 400 * DAY, expiresAt: NOW - 30 * DAY },
  ];
  const before = tokens.map(({ id }) => id);
  assert.deepEqual(
    [...ApiTokens.forDisplay(tokens, NOW)].map(({ id }) => id),
    ["new", "old", "expired-new", "expired-old"]
  );
  assert.deepEqual(tokens.map(({ id }) => id), before);
});
