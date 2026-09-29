const { test } = require("node:test");
const assert = require("node:assert/strict");

const { planCollections, hostsOf, checkTarget } = require("./restore_plan");

const MANIFEST = [
  { name: "bookEntries", file: "bookEntries.json" },
  { name: "bookReviews", file: "bookReviews.json" },
  { name: "apiTokens", file: "apiTokens.json" },
];

const names = (collections) => collections.map(({ name }) => name);

test("a default restore skips apiTokens and says so", () => {
  const { restore, skipped } = planCollections({ collections: MANIFEST });
  assert.deepEqual(names(restore), ["bookEntries", "bookReviews"]);
  assert.deepEqual(names(skipped), ["apiTokens"]);
  assert.match(skipped[0].reason, /--only=apiTokens/);
});

test("--only=apiTokens restores it", () => {
  const { restore, skipped } = planCollections({
    collections: MANIFEST,
    only: ["apiTokens"],
  });
  assert.deepEqual(names(restore), ["apiTokens"]);
  assert.deepEqual(skipped, []);
});

test("--only naming it beside others restores it with them", () => {
  const { restore } = planCollections({
    collections: MANIFEST,
    only: ["bookReviews", "apiTokens"],
  });
  assert.deepEqual(names(restore), ["bookReviews", "apiTokens"]);
});

test("--only leaving it out does not report it as skipped", () => {
  const { restore, skipped } = planCollections({
    collections: MANIFEST,
    only: ["bookReviews"],
  });
  assert.deepEqual(names(restore), ["bookReviews"]);
  assert.deepEqual(skipped, []);
});

test("a snapshot from before apiTokens existed plans as before", () => {
  const { restore, skipped } = planCollections({
    collections: MANIFEST.slice(0, 2),
  });
  assert.deepEqual(names(restore), ["bookEntries", "bookReviews"]);
  assert.deepEqual(skipped, []);
});

test("hostsOf drops the credentials, the database and the options", () => {
  assert.equal(
    hostsOf("mongodb+srv://user:p%40ss@Cluster0.ABC.mongodb.net/memo?retryWrites=true"),
    "cluster0.abc.mongodb.net"
  );
  assert.equal(hostsOf("mongodb://localhost:27017"), "localhost:27017");
});

test("hostsOf sorts a seed list so its order does not matter", () => {
  assert.equal(
    hostsOf("mongodb://u:p@h2:27017,h1:27017/memo?replicaSet=rs0"),
    "h1:27017,h2:27017"
  );
});

test("hostsOf rejects what is not a mongodb URL", () => {
  assert.equal(hostsOf(undefined), undefined);
  assert.equal(hostsOf(""), undefined);
  assert.equal(hostsOf("https://example.com"), undefined);
});

const PRODUCTION = "mongodb+srv://u:secret@prod.abc.mongodb.net/memo";
const SCRATCH = "mongodb+srv://u:secret@scratch.xyz.mongodb.net/";
const ENV_FILE = "/repo/src/db_maintenance/.env";

const check = (overrides) =>
  checkTarget({
    connectionUrl: SCRATCH,
    productionUrl: PRODUCTION,
    envFile: ENV_FILE,
    ...overrides,
  });

test("a target matching a scratch URL is allowed", () => {
  assert.deepEqual(check({ target: "scratch.xyz.mongodb.net" }), {
    host: "scratch.xyz.mongodb.net",
    isProduction: false,
  });
});

test("the target is compared without regard to case", () => {
  assert.equal(check({ target: "Scratch.XYZ.mongodb.net" }).refusal, undefined);
});

test("no --target is refused, naming the host MONGODB_URL points at", () => {
  for (const target of [undefined, true, ""]) {
    const { refusal } = check({ target });
    assert.match(refusal, /--target=<host> is required/);
    assert.match(refusal, /scratch\.xyz\.mongodb\.net/);
  }
});

test("a target that is not where MONGODB_URL points is refused", () => {
  const { refusal } = check({
    connectionUrl: PRODUCTION,
    target: "scratch.xyz.mongodb.net",
  });
  assert.match(refusal, /--target says scratch\.xyz\.mongodb\.net/);
  assert.match(refusal, /points at prod\.abc\.mongodb\.net/);
});

test("the production host is refused without --production", () => {
  const { refusal } = check({
    connectionUrl: PRODUCTION,
    target: "prod.abc.mongodb.net",
  });
  assert.match(refusal, /is the production host/);
  assert.match(refusal, /--production/);
});

test("the production host is allowed with --production", () => {
  assert.deepEqual(
    check({
      connectionUrl: PRODUCTION,
      target: "prod.abc.mongodb.net",
      production: true,
    }),
    { host: "prod.abc.mongodb.net", isProduction: true }
  );
});

test("--production aimed at another host is refused", () => {
  const { refusal } = check({
    target: "scratch.xyz.mongodb.net",
    production: true,
  });
  assert.match(refusal, /is not the production host/);
});

test("a seed list sharing one member with production counts as production", () => {
  const { refusal } = check({
    connectionUrl: "mongodb://u:p@other:27017,prod:27017/",
    productionUrl: "mongodb://u:p@prod:27017/",
    target: "prod:27017,other:27017",
  });
  assert.match(refusal, /is the production host/);
});

test("with no production URL in the .env the restore is refused outright", () => {
  for (const production of [false, true]) {
    const { refusal } = check({
      productionUrl: undefined,
      target: "scratch.xyz.mongodb.net",
      production,
    });
    assert.match(refusal, /Cannot tell which host is production/);
    assert.match(refusal, /MEMO_ENV_FILE/);
  }
});

test("an unset MONGODB_URL is refused before anything else", () => {
  const { refusal } = check({ connectionUrl: undefined, target: "x" });
  assert.match(refusal, /MONGODB_URL is not set/);
});

test("no refusal ever prints a password", () => {
  const cases = [
    {},
    { target: "nope" },
    { connectionUrl: PRODUCTION, target: "prod.abc.mongodb.net" },
    { productionUrl: undefined, target: "scratch.xyz.mongodb.net" },
  ];
  for (const overrides of cases) {
    assert.doesNotMatch(check(overrides).refusal, /secret/);
  }
});
