/**
 * @file The frontend bundle is built by `_data/assets.js`: it reads every file
 * listed in `asset_plan.js`, wraps each in its own IIFE, minifies the result,
 * and names it after a digest of the bytes that come out. `js/bundle.njk` emits
 * those bytes at that url and `layouts/base.njk` loads the same url from the
 * same object.
 *
 * The digest is the thing to protect. `netlify.toml` serves `/js/*` and
 * `/css/*` with `immutable` for a year, which is only true if a change to any
 * bundled file changes the url — and only checkable if exactly one place
 * decides what that url is. A second place computing the name would not fail
 * loudly; it would fail a year from now in someone else's browser.
 *
 * The other failure mode here is older and blunter: a syntax error anywhere in
 * the concatenation is one broken 140KB file, and every page on this site is
 * drawn by that file, so the build is green, the deploy is green, and the whole
 * site is blank.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const plan = require("./asset_plan");

const INCLUDES = path.join(__dirname, "..");
const FRONTEND = path.join(INCLUDES, "..");
const BUNDLE = path.join(FRONTEND, "js", "bundle.njk");
const STYLESHEET_TEMPLATE = path.join(FRONTEND, "css", "main.njk");
const LAYOUT = path.join(INCLUDES, "layouts", "base.njk");
const ROOT = path.join(FRONTEND, "..", "..");
const DATA = path.join(FRONTEND, "_data", "assets.js");
const REDIRECTS = path.join(ROOT, "_redirects");
const NETLIFY = path.join(ROOT, "netlify.toml");

const read = (file) => fs.readFileSync(file, "utf8");

test("the bundle still lists the frontend scripts", () => {
  assert.ok(plan.BUNDLED_FILES.length > 0, "asset_plan.js bundles nothing");
});

test("every file the bundle lists exists", () => {
  plan.BUNDLED_FILES.forEach((includePath) =>
    assert.ok(
      fs.existsSync(path.join(INCLUDES, includePath)),
      `asset_plan.js lists ${includePath}, which does not exist`
    )
  );
  assert.ok(
    fs.existsSync(path.join(INCLUDES, plan.STYLESHEET)),
    `asset_plan.js names ${plan.STYLESHEET}, which does not exist`
  );
});

test("bundle.njk emits the shared bytes at the shared url", () => {
  const source = read(BUNDLE);

  // Both halves matter. A permalink that named a fixed url would be cached
  // `immutable` under a name that never changes; a body that rebuilt the
  // bundle some other way would be hashed under a name describing something
  // else. `assets.js.url` and `assets.js.code` are the one object.
  assert.match(
    source,
    /^---\r?\n(?:.*\r?\n)*?permalink:\s*["']?\{\{\s*assets\.js\.url\s*\}\}["']?\s*\r?$/m,
    "bundle.njk must take its permalink from assets.js.url"
  );
  assert.match(
    source,
    /\{\{-?\s*assets\.js\.code\s*\|\s*safe\s*-?\}\}/,
    "bundle.njk must emit assets.js.code, the bytes that url was hashed from"
  );
});

test("main.njk emits the stylesheet at the shared url", () => {
  const source = read(STYLESHEET_TEMPLATE);

  assert.match(
    source,
    /^---\r?\n(?:.*\r?\n)*?permalink:\s*["']?\{\{\s*assets\.css\.url\s*\}\}["']?\s*\r?$/m,
    "css/main.njk must take its permalink from assets.css.url"
  );
  assert.match(
    source,
    /\{\{-?\s*assets\.css\.code\s*\|\s*safe\s*-?\}\}/,
    "css/main.njk must emit assets.css.code"
  );
});

test("base.njk loads both assets from the same data, and inlines neither", () => {
  const layout = read(LAYOUT);

  assert.match(
    layout,
    /<script[^>]*\bsrc="\{\{\s*assets\.js\.url\s*\}\}"><\/script>/,
    "base.njk must load the bundle from assets.js.url, not a url of its own"
  );
  assert.match(
    layout,
    /<link rel="stylesheet" href="\{\{\s*assets\.css\.url\s*\}\}">/,
    "base.njk must load the stylesheet from assets.css.url"
  );
  assert.doesNotMatch(
    layout,
    /\{%\s*include\s+"(?:js|css)\//,
    "base.njk inlines frontend files again; the list belongs in asset_plan.js"
  );
});

test("the bundle defers, and nothing inline races it", () => {
  // These two go together. `defer` stops the bundle blocking the parser, but a
  // deferred script runs after every inline one, so any inline block that
  // reaches for `Components` would find nothing there — which is the state
  // this replaced. The drawing code lives in `js/boot.js` at the end of the
  // bundle now, and <body> has no script of its own to get ahead of it.
  const layout = read(LAYOUT);

  assert.match(
    layout,
    /<script\s+defer\s+src="\{\{\s*assets\.js\.url\s*\}\}"><\/script>/,
    "the bundle must be deferred; it draws the page and blocks the parser"
  );

  const inline = [...layout.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => body.trim())
    .filter(Boolean);

  assert.deepEqual(
    inline,
    [],
    "base.njk has an inline script again; it runs before the deferred bundle, " +
      "so anything it reaches for in `Components` is not there yet"
  );

  assert.equal(
    plan.BUNDLED_FILES[plan.BUNDLED_FILES.length - 1],
    "js/boot.js",
    "js/boot.js draws the page with what every file above it defines, so it " +
      "has to be bundled last"
  );
});

test("only asset_plan.js decides what the assets are called", () => {
  // A hardcoded `/js/bundle.js` or `/css/main.css` anywhere is either a 404 or,
  // worse, a second name for a file whose name is supposed to be its digest.
  [
    ["base.njk", LAYOUT],
    ["bundle.njk", BUNDLE],
    ["css/main.njk", STYLESHEET_TEMPLATE],
  ].forEach(([name, file]) =>
    assert.doesNotMatch(
      read(file),
      /(?:href|src)="\/(?:js|css)\//,
      `${name} names an asset url literally; it must come from the assets data`
    )
  );
});

test("a change to any bundled file changes the url", () => {
  // The invariant `immutable` rests on, checked on the pure functions so it
  // needs no install: same bytes, same name; different bytes, different name.
  const one = plan.concatenate(["window.x = 1"]);
  const other = plan.concatenate(["window.x = 2"]);

  assert.notEqual(plan.digest(one), plan.digest(other));
  assert.equal(plan.digest(one), plan.digest(plan.concatenate(["window.x = 1"])));

  assert.notEqual(plan.bundleUrl(plan.digest(one)), plan.bundleUrl(plan.digest(other)));
  assert.match(plan.bundleUrl(plan.digest(one)), new RegExp(plan.digest(one)));
  assert.match(
    plan.stylesheetUrl(plan.digest(one)),
    new RegExp(plan.digest(one)),
    "the stylesheet url must carry its digest too; /css/* is immutable as well"
  );
});

test("assets.js re-reads on every build", () => {
  // Node caches the module, so an object export would freeze the bundle at
  // whatever the first build of a `--serve` process read off disk, and editing
  // a component would stop changing the page.
  //
  // Read rather than required: `_data/assets.js` pulls in uglify-js, and this
  // suite runs with no install.
  assert.match(
    read(DATA),
    /module\.exports\s*=\s*\(\s*\)\s*=>/,
    "_data/assets.js must export a function, or `--serve` serves a stale bundle"
  );
});

test("the SPA catch-all is not forced, so the assets are served as files", () => {
  // This is the whole reason netlify.toml's headers do anything. Netlify does
  // not put a custom header on a response it produced by rewriting, and a
  // forced rule rewrites a url even when it exists as a file — so a forced
  // catch-all made every response on the site a rewrite, and every header rule
  // inert. That is not hypothetical: it is what #157 shipped, and production
  // answered the hashed bundle `max-age=0, must-revalidate` regardless.
  //
  // Unforced, a file that exists is served as itself and keeps its headers.
  const redirects = read(REDIRECTS);

  assert.match(
    redirects,
    /^\/\*\s+\/index\.html\s+200\s*$/m,
    "the catch-all must be `/*  /index.html  200` and must not be forced; " +
      "forced, it rewrites the hashed assets and netlify.toml's Cache-Control " +
      "silently stops applying to anything"
  );

  // A forced rule above it would do the same to whatever it covers, which is
  // exactly what the `/js/*` and `/css/*` self-rules used to do.
  const forced = [...redirects.matchAll(/^(\S+)\s+\S+\s+200!/gm)].map(([, from]) => from);

  const hash = plan.digest("sample");
  const assets = [
    plan.bundleUrl(hash),
    plan.stylesheetUrl(hash),
    // Only <link> and <script> load assets. The <noscript> block links
    // `/films/nil` and `/api/export/films/nil`, which are a page and a
    // function — both of them are supposed to reach the catch-all.
    ...[
      ...read(LAYOUT).matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="(\/[^"{]*)"/g),
    ].map(([, url]) => url),
  ];

  assert.ok(assets.length > 2, "found no local assets in base.njk");

  assets.forEach((url) =>
    forced.forEach((from) => {
      const pattern = new RegExp(`^${from.replace(/[.]/g, "\\$&").replace(/\*$/, ".*")}$`);
      assert.ok(
        !pattern.test(url),
        `_redirects forces ${from}, which covers ${url}; a rewritten response ` +
          `is served without the Cache-Control netlify.toml gives it`
      );
    })
  );
});

test("the immutable headers cover the directories the assets are emitted to", () => {
  // `immutable` on a url whose contents can change under it is the one way
  // this gets worse rather than better, so the rule and the hashed name are
  // checked against each other rather than each being trusted on its own.
  const netlify = read(NETLIFY);
  const hash = plan.digest("sample");

  [plan.bundleUrl(hash), plan.stylesheetUrl(hash)].forEach((url) => {
    const directory = url.slice(0, url.indexOf("/", 1) + 1);
    const rule = new RegExp(
      `\\[\\[headers\\]\\]\\s*for\\s*=\\s*"${directory}\\*"\\s*` +
        `\\[headers\\.values\\]\\s*Cache-Control\\s*=\\s*"[^"]*immutable"`
    );

    assert.match(
      netlify.replace(/#.*$/gm, ""),
      rule,
      `netlify.toml has no immutable Cache-Control for ${directory}*, which is ` +
        `where ${url} is served from`
    );
  });
});

test("components/index.js comes before the files that populate it", () => {
  // It is the file that creates the `Components` global and the `Components.UI`
  // / `.Home` / `.Profile` / `.List` objects every other component assigns
  // into. Order is load-bearing across the whole list; this is the edge of it
  // that turns into a TypeError on a blank page rather than something subtle.
  const files = plan.BUNDLED_FILES;
  const root = files.indexOf("js/components/index.js");

  assert.notEqual(root, -1, "js/components/index.js is no longer bundled");

  files.forEach((includePath, i) => {
    if (!includePath.startsWith("js/components/") || i === root) return;
    assert.ok(
      i > root,
      `${includePath} is bundled before js/components/index.js, which is what ` +
        `creates the Components object it assigns into`
    );
  });
});

test("the concatenated bundle parses as JavaScript", () => {
  // Exactly what `_data/assets.js` hands to UglifyJS, built by the same pure
  // function. `new Function` compiles the body without running it, so this is a
  // syntax check and nothing more — but a syntax error here is the whole site,
  // blank.
  const bundle = plan.concatenate(
    plan.BUNDLED_FILES.map((includePath) => read(path.join(INCLUDES, includePath)))
  );

  assert.doesNotThrow(
    () => new Function(bundle),
    "the bundle does not parse, so every page on the site would be blank"
  );
});
