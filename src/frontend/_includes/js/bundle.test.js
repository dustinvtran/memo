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
const HEADERS = path.join(ROOT, "_headers");
const ELEVENTY = path.join(ROOT, ".eleventy.js");

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

test("the hashed assets are exempt from the SPA catch-all", () => {
  // `/*  /index.html  200!` is forced, so it rewrites urls that exist as files
  // too. An asset is only served as itself if it has a forced rule of its own,
  // the way `/img/*` does. Without one, the bundle answers with the homepage's
  // HTML and the site is blank with `Unexpected token '<'`. The hashed names
  // have to keep matching those rules, which is why they keep their directory.
  const exempt = [
    ...read(REDIRECTS).matchAll(/^(\/\S*?)\/\*\s+\S+\s+200!/gm),
  ].map(([, prefix]) => prefix + "/");

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
    assert.ok(
      exempt.some((prefix) => url.startsWith(prefix)),
      `${url} is served by no forced rule in _redirects, so the catch-all ` +
        `answers it with index.html`
    )
  );
});

test("the immutable headers cover the directories the assets are emitted to", () => {
  // `immutable` on a url whose contents can change under it is the one way this
  // gets worse rather than better, so the rule and the hashed name are checked
  // against each other rather than each being trusted on its own.
  const headers = read(HEADERS).replace(/^\s*#.*$/gm, "");
  const hash = plan.digest("sample");

  [plan.bundleUrl(hash), plan.stylesheetUrl(hash)].forEach((url) => {
    const directory = url.slice(0, url.indexOf("/", 1) + 1);
    const rule = new RegExp(
      `^${directory.replace("/", "\\/")}\\*\\s*$\\s*^\\s+Cache-Control:\\s*[^\\n]*immutable`,
      "m"
    );

    assert.match(
      headers,
      rule,
      `_headers has no immutable Cache-Control for ${directory}*, which is ` +
        `where ${url} is served from`
    );
  });
});

test("_headers is the mechanism, and it reaches the publish directory", () => {
  // Declaring these in `netlify.toml` is the other documented way and it never
  // applied on this site: #157 shipped exactly these two rules that way and
  // production kept answering the hashed bundle `max-age=0, must-revalidate`.
  // Moving them back would switch the caching off without failing a thing, so
  // the absence is asserted rather than left to memory.
  assert.doesNotMatch(
    read(NETLIFY).replace(/^\s*#.*$/gm, ""),
    /\[\[headers\]\]/,
    "netlify.toml declares [[headers]] again; those never applied here, and " +
      "having both is two places to read one answer from"
  );

  // A `_headers` at the repo root is read by nothing. It has to be copied into
  // the publish directory, the way `_redirects` is.
  assert.match(
    read(ELEVENTY),
    /addPassthroughCopy\('\.\/_headers'\)/,
    ".eleventy.js must copy _headers into dist/, or Netlify never sees it"
  );
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

test("conversions.js comes before the files that derive from it", () => {
  // It holds `WORK_TYPES`, the frontend's one table of work types, and these
  // three read it as they load: `utils/netlify.js` takes the profile's list
  // order off it, `components/router.js` destructures its membership test, and
  // `utils/tables.js` hands it back a type to get that table's columns. #221
  // folded four restatements into it, and the price of one table is that it
  // has to be above everything spending it.
  const files = plan.BUNDLED_FILES;
  const table = files.indexOf("js/utils/conversions.js");

  assert.notEqual(table, -1, "js/utils/conversions.js is no longer bundled");

  [
    "js/utils/netlify.js",
    "js/utils/tables.js",
    "js/components/router.js",
    "js/components/list/index.js",
  ].forEach((includePath) =>
    assert.ok(
      files.indexOf(includePath) > table,
      `${includePath} is bundled before js/utils/conversions.js, which is ` +
        `what defines the Conversions table it reads`
    )
  );

  // The one backwards reference, and the reason `columns` is a function: the
  // column lists live in conversions.js but are built out of `Columns`, which
  // is set below it. conversions.test.js asserts the deferral that makes this
  // legal; this asserts that it is still needed.
  assert.ok(
    files.indexOf("js/utils/columns.js") > table,
    "js/utils/columns.js moved above conversions.js; the note there about " +
      "deferring the `Columns` lookup to call time is now stale"
  );
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

test("every file under _includes/js is bundled, or is a test", () => {
  // The failure this catches is the quiet one: a file nobody added to
  // BUNDLED_FILES is not in the bundle, and nothing says so. The build is
  // green, the deploy is green, and whatever reached for its globals is
  // `undefined` in the browser. `asset_plan.js` is the one exception because
  // it is what builds the bundle rather than something in it.
  const walk = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  const bundled = new Set(plan.BUNDLED_FILES);
  const missing = walk(path.join(INCLUDES, "js"))
    .map((full) => path.relative(INCLUDES, full).split(path.sep).join("/"))
    .filter((includePath) => includePath.endsWith(".js"))
    .filter((includePath) => !includePath.endsWith(".test.js"))
    .filter((includePath) => includePath !== "js/asset_plan.js")
    .filter((includePath) => !bundled.has(includePath));

  assert.deepEqual(
    missing,
    [],
    "these files are in _includes/js but not in BUNDLED_FILES, so they are " +
      "not in the bundle and their globals are undefined at runtime"
  );
});

test("no bundled file writes behaviour into the markup it builds", () => {
  // `script-src` in `_headers` grants neither `'unsafe-inline'` nor
  // `'unsafe-eval'`, so an inline handler or an inline `<script>` coming out of
  // a formatter is a feature that stops working the day that header is
  // enforced, silently and in the browser only. That is what #219 was: an
  // owner's edit button, and — through a `<scr` + `ipt>` the grep for a script
  // tag would have missed — every comment panel on the site, for every visitor.
  //
  // The policy and the markup are checked against each other rather than either
  // being trusted alone: granting `'unsafe-inline'` deliberately is what would
  // make this check wrong to keep, and it fails here rather than passing
  // quietly.
  const policy = read(HEADERS).replace(/^\s*#.*$/gm, "");
  const scriptSrc = policy.match(/script-src[^;]*/)?.[0];

  assert.ok(scriptSrc, "_headers declares no script-src at all");
  assert.doesNotMatch(
    scriptSrc,
    /'unsafe-(inline|eval)'/,
    "script-src has been loosened; this check is about what that would buy, " +
      "so decide which of the two is meant to be true"
  );

  // Comments go first: the reason a file has no inline handler is usually a
  // sentence saying so, and a check that a comment can fail is a check that
  // gets worked around rather than read.
  const withoutComments = (code) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  plan.BUNDLED_FILES.forEach((includePath) => {
    const code = withoutComments(read(path.join(INCLUDES, includePath)));

    assert.doesNotMatch(
      code,
      /<scr/i,
      `${includePath} builds a script tag, which script-src refuses`
    );
    assert.doesNotMatch(
      code,
      /\son[a-z]+\s*=\s*["'`]/i,
      `${includePath} writes an inline event handler, which script-src refuses`
    );
  });
});
