/**
 * @file The home page's reading of `GET /api/name`, which is where #216 was
 * visible: the endpoint answered `200 {}` to an expired token and the page
 * drew "Hi undefined!", linking to `/profile/undefined`.
 *
 * The frontend scripts are plain globals concatenated into a bundle rather
 * than modules, so this loads index.js into a vm context with the globals it
 * expects and pulls the components out of the script's scope — the same trick
 * as profile_stats.test.js. `Utils` is the real thing, loaded the same way,
 * because `escapeHtml` is part of what the markup below is being asked about.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const js = (...segments) =>
  fs.readFileSync(path.join(__dirname, ...segments), "utf8");

const source = js("index.js");
const generalSource = js("..", "..", "utils", "general.js");

// Stubs for the rest: nothing under test talks to Netlify or draws a profile
// list. They exist because the file destructures all of these at load time,
// and because it writes itself onto `Components.Home`.
//
// `initComponent` hands back the spec it was given, so a component can be
// rendered here by calling its `content`. That is what the real one does with
// it, minus the id, the style and the DOM.
const context = vm.createContext({
  URL,
  console,
  Netlify: { isLoggedIn: () => true, getUserName: () => REMOTE_DATA },
  Components: {
    initComponent: (spec) => spec,
    WithRemoteData: (args) => args,
    Redirect: (url) => ({ content: () => `<redirect to="${url}">` }),
    // Named rather than reproduced, so that a failure sent to the shared
    // default is visible here as having gone there.
    RemoteFailure: (err) => ({
      content: () => `<remote-failure ${err.status}: ${err.message}>`,
    }),
    Profile: { ProfileLists: () => ({ content: () => "<profile-lists>" }) },
    UI: { Base: (_title, child) => child },
    Home: { UsernameSetter: () => ({ content: () => "<username-setter>" }) },
  },
});

const load = (source, exports) =>
  vm.runInContext(`(() => {\n${source}\n;return ${exports}\n})()`, context);

load(generalSource, "undefined");

const { HomePage } = load(source, "({ HomePage })");

/** Stands in for the `ResultAsync` the page would really be handed. */
const REMOTE_DATA = Symbol("getUserName()");

const render = (component) => component.content({ id: "x", include: render });

/**
 * What `HomePage` hands `WithRemoteData` — the wiring is the point rather than
 * the components in isolation, since the bug was a failure reaching a
 * component that only knew how to draw successes.
 *
 * Rendered with `include` left as itself rather than through `render`, because
 * what comes back here is the argument list `WithRemoteData` was called with
 * and not markup.
 */
const wiring = () => HomePage().content({ include: (component) => component });

test("the page asks for the name and draws the answer", () => {
  const { remoteData, component } = wiring();

  assert.equal(remoteData, REMOTE_DATA);
  assert.match(render(component({ username: "nil" })), /Hi nil!/);
});

test("a name that has not been picked yet draws the setter", () => {
  const { component } = wiring();

  assert.match(render(component({ error: "NoUsernameSet" })), /<username-setter>/);
});

///////////////////////////////////////////////////////////////////////////////
// The failures, which used to arrive as `200 {}` and take none of the branches
// above — so the page drew a greeting to a user it had never been told about.

/** The shape `Http` hands on for a failed request, as of #234. */
const failure = (status, message) => ({ status, error: "Whatever", message });

test("a failed request is not drawn as a user with no name", () => {
  const { errorComponent } = wiring();

  // Whatever it says, it does not say this. `escapeHtml(undefined)` is the
  // string "undefined", so the greeting rendered perfectly happily.
  for (const status of [401, 500]) {
    assert.doesNotMatch(render(errorComponent(failure(status, "no"))), /Hi undefined!/);
  }
});

test("a 401 offers a way back in rather than a message", () => {
  const { errorComponent } = wiring();

  // The cookie is still in the jar and the API will not take it: the session
  // has ended, and logging in again is the only thing that fixes it. "not
  // authorized" is true and is no use to the person reading it.
  const drawn = render(errorComponent(failure(401, "not authorized")));

  assert.match(drawn, /session has ended/i);
  assert.match(drawn, /href="\/\.netlify\/functions\/auth\/login"/);
  assert.doesNotMatch(drawn, /not authorized/);
});

test("any other failure is drawn the way every other failure is", () => {
  const { errorComponent } = wiring();

  // A database that did not answer is not a session to log into again. The
  // page says what the API said and leaves the wording of it in one place.
  const drawn = render(errorComponent(failure(500, "the database did not answer")));

  assert.match(drawn, /<remote-failure 500: the database did not answer>/);
  assert.doesNotMatch(drawn, /log in/i);
});
