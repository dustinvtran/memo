/**
 * @file The setter used to fail silently: `Netlify.setName(...).map(...)` with
 * no `mapErr`, so every non-2xx skipped the handler and the button just did
 * not appear to work — and the rule a name has to satisfy was written down
 * nowhere the user could see it. See #217.
 *
 * The frontend scripts are plain globals concatenated into a bundle rather
 * than modules, so this loads the file into a vm context with the globals it
 * expects and pulls the handlers out of the script's scope — the same trick as
 * profile_stats.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HERE = path.join(__dirname, "username_setter.js");
const PARSER = path.join(
  __dirname, "..", "..", "..", "..", "..",
  "api", "utils", "parsers", "users.js"
);

const source = fs.readFileSync(HERE, "utf8");

/**
 * Enough of neverthrow for the two paths through the handler. `setName`
 * returns a `ResultAsync`, and the bug was that only one of its two sides was
 * ever wired up.
 */
const ok = (value) => ({
  map: (f) => (f(value), ok(value)),
  mapErr: () => ok(value),
});
const err = (error) => ({
  map: () => err(error),
  mapErr: (f) => (f(error), err(error)),
});

/**
 * Loads the file the way the bundle would — its own scope, the globals it
 * destructures at the top, and `Netlify` answering whatever the test wants —
 * and hands back the component along with what it did to the page.
 */
const load = (response) => {
  const notifications = [];
  const redirects = [];

  const context = vm.createContext({
    Netlify: { setName: () => response },
    Utils: { escapeHtml: (text) => String(text).replace(/</g, "&lt;") },
    Components: {
      // `initComponent` is given `{ content }` and hands `content` an
      // `include`; both are identity here, so `UsernameSetter().content(...)`
      // comes back as the arguments `InputWithAction` was built with.
      initComponent: (component) => component,
      UI: {
        InputWithAction: (args) => args,
        showNotification: (message) => notifications.push(message),
      },
      Home: {},
    },
    // The success path redirects on a timer. Fired straight away rather than
    // waited for: what is under test is where it goes, not when.
    setTimeout: (f) => f(),
    window: { location: { set href(url) { redirects.push(url); } } },
  });

  const { UsernameSetter } = vm.runInContext(
    `(() => {
${source}
;return ({ UsernameSetter })
})()`,
    context
  );

  return { input: UsernameSetter().content({ include: (x) => x }), notifications, redirects };
};

/** Clicks Submit with `name`, against a `setName` that answers `response`. */
const submit = (name, response) => {
  const { input, notifications, redirects } = load(response);
  input.onSubmit(name);
  return { notifications, redirects };
};

test("a name the parser would refuse never leaves the browser", () => {
  // Each of these is a 400 from `usernameParser`, and each of them was
  // silence: no message, no error, nothing.
  ["", "a", "x".repeat(17), "has a space", "with-a-hyphen", "under_score",
    "a.dot", "café"].forEach((name) => {
    const { notifications, redirects } = submit(name, ok({}));

    assert.equal(
      notifications.length, 1,
      `"${name}" produced ${notifications.length} notifications, not one`
    );
    assert.deepEqual(redirects, [], `"${name}" was sent anyway`);
  });
});

test("every refusal states the whole rule, so the next attempt works", () => {
  ["", "a", "x".repeat(17), "has a space"].forEach((name) => {
    const [message] = submit(name, ok({})).notifications;

    assert.match(
      message, /2 to 16 letters and numbers/,
      `"${name}" was refused without saying what a username is`
    );
  });
});

test("a name that satisfies the rule is sent, and redirects on success", () => {
  const { notifications, redirects } = submit("someone12", ok({}));

  assert.match(notifications[0], /Successfully picked new name/);
  assert.deepEqual(redirects, ["/profile/someone12"]);
});

test("the label carries the rule before anything is typed", () => {
  assert.match(load(ok({})).input.label, /2 to 16 letters and numbers, nothing else/);
});

test("a taken name is reported with the name in it", () => {
  // `feErrors.nameTaken` builds `context` for exactly this, and the handler
  // used to throw it away for a sentence without the name.
  const { notifications, redirects } = submit(
    "someone12",
    ok({ error: "NameTaken", context: "someone12 is already taken." })
  );

  assert.deepEqual(notifications, ["someone12 is already taken."]);
  assert.deepEqual(redirects, []);
});

test("an unrecognised frontend error is not reported as a taken name", () => {
  // The bug this guards: every `FrontendError` is truthy, so branching on
  // `resp.error` rather than on its name meant a second error added to
  // `api/utils/frontend_errors.js` would come out as "already taken".
  const { notifications, redirects } = submit(
    "someone12",
    ok({ error: "SomethingElse" })
  );

  assert.doesNotMatch(notifications[0], /taken/);
  assert.deepEqual(redirects, []);
});

test("a refused request says something rather than nothing", () => {
  // #217 itself: no `mapErr` meant the whole handler was skipped.
  const { notifications, redirects } = submit("someone12", err(500));

  assert.equal(notifications.length, 1);
  assert.doesNotMatch(
    notifications[0], /Successfully/,
    "a failed request reported success"
  );
  assert.deepEqual(redirects, []);
});

test("a failure carrying a message shows it, and one carrying none does not", () => {
  // `Http.makeRequest` reduces a failure to a bare status code today (#222).
  // A number is not a message and must not be shown as one; a real message,
  // when one survives, should be.
  assert.match(
    submit("someone12", err({ message: "the server is on fire" }))
      .notifications[0],
    /the server is on fire/
  );
  assert.doesNotMatch(
    submit("someone12", err(500)).notifications[0],
    /500|undefined|\[object/
  );
});

test("the bounds match the parser they were copied from", () => {
  // The comment in username_setter.js names parsers/users.js as the source of
  // truth, and the bundle has no module system to enforce that with (#221).
  // Read out of both files rather than imported: this suite runs with no
  // install, and the parser is ESM that pulls in zod.
  const parser = fs.readFileSync(PARSER, "utf8");

  ["MIN_USERNAME_LENGTH", "MAX_USERNAME_LENGTH"].forEach((name) => {
    const find = (text) =>
      text.match(new RegExp(`const ${name} = ([0-9]+)`))?.[1];

    assert.ok(find(parser), `${name} is no longer exported from parsers/users.js`);
    assert.equal(
      find(source), find(parser),
      `username_setter.js says ${name} is ${find(source)} and the parser ` +
        `says ${find(parser)}; the rule shown to the user is not the rule`
    );
  });
});
