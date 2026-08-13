/**
 * @file The frontend bundle is built by Nunjucks `{% include %}`-ing every file
 * listed in `src/frontend/js/bundle.njk` into one file, each wrapped in its own
 * IIFE, emitted to `/js/bundle.js` and loaded by base.njk from that url. So
 * Nunjucks reads these .js files as templates, and anything that looks like a
 * Nunjucks delimiter is not JavaScript to it.
 *
 * When that happens nothing fails loudly: the include renders to nothing, the
 * IIFE around it loses its closing brace, and the whole 140KB bundle becomes
 * one syntax error. The build is green, the deploy is green, and every page on
 * the site is blank. A JSDoc `@typedef` with a brace pair cost us exactly that,
 * so the delimiters are worth a test — as is the bundle parsing at all, which
 * is the check that catches the next cause rather than that one.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INCLUDES = path.join(__dirname, "..");
const BUNDLE = path.join(INCLUDES, "..", "js", "bundle.njk");
const LAYOUT = path.join(INCLUDES, "layouts", "base.njk");
const ROOT = path.join(INCLUDES, "..", "..", "..");
const ELEVENTY = path.join(ROOT, ".eleventy.js");
const REDIRECTS = path.join(ROOT, "_redirects");

const read = (file) => fs.readFileSync(file, "utf8");

/** The files bundle.njk inlines, in the order it inlines them. */
const includedFiles = () =>
  [...read(BUNDLE).matchAll(/\{\{\s*js\("([^"]+)"\)\s*\}\}/g)].map(
    ([, includePath]) => includePath
  );

/** `{{ … }}` interpolates, `{% … %}` is a tag, `{# … #}` is a comment. */
const DELIMITERS = [
  ["{{", /\{\{/],
  ["{%", /\{%/],
  ["{#", /\{#/],
];

test("bundle.njk still inlines the frontend scripts", () => {
  assert.ok(includedFiles().length > 0, "found no js() includes in bundle.njk");
});

test("bundle.njk emits the bundle to a url, minified", () => {
  const source = read(BUNDLE);

  assert.match(
    source,
    /^---\r?\n(?:.*\r?\n)*?permalink:\s*\/js\/bundle\.js\s*\r?$/m,
    "bundle.njk must emit to /js/bundle.js, which is the url base.njk loads"
  );
  assert.match(
    source,
    /\{\{\s*scripts\s*\|\s*jsmin\s*\|\s*safe\s*\}\}/,
    "the bundle must go through the jsmin filter"
  );
});

test("bundle.njk still wraps each file in its own IIFE", () => {
  // `const` at the top level of a file would otherwise collide with the same
  // name in any other file — they share one global scope. The concatenation
  // this file's parse test builds mirrors this macro, so it has to hold.
  assert.match(
    read(BUNDLE),
    /\{%\s*macro js\(path\)\s*%\}\s*\(\(\)\s*=>\s*\{\s*\{%\s*include path\s*%\}\s*\}\)\(\);\s*\{%\s*endmacro\s*%\}/,
    "the js() macro no longer wraps its include in an IIFE"
  );
});

test("base.njk loads the bundle by url and inlines no frontend script", () => {
  const layout = read(LAYOUT);

  assert.match(
    layout,
    /<script src="\/js\/bundle\.js"><\/script>/,
    "base.njk must load /js/bundle.js"
  );
  assert.equal(
    [...layout.matchAll(/\{\{\s*js\("([^"]+)"\)\s*\}\}/g)].length,
    0,
    "base.njk inlines frontend files again; the list belongs in bundle.njk"
  );
});

test("the stylesheet is served from a url, not inlined", () => {
  const layout = read(LAYOUT);

  assert.match(layout, /<link rel="stylesheet" href="\/css\/main\.css">/);
  assert.doesNotMatch(
    layout,
    /\{%\s*include\s+"css\/main\.css"\s*%\}/,
    "base.njk inlines the stylesheet again"
  );
  assert.match(
    read(ELEVENTY),
    /addPassthroughCopy\(\{[^}]*'\.\/src\/frontend\/_includes\/css\/main\.css':\s*'css\/main\.css'/,
    ".eleventy.js must copy main.css to /css/, or that <link> is a 404"
  );
});

test("the assets base.njk loads are exempt from the SPA catch-all", () => {
  // `/*  /index.html  200!` is forced, so it rewrites urls that exist as files
  // too. An asset is only served as itself if it has a forced rule of its own,
  // the way `/img/*` does. Without one, `/js/bundle.js` answers with the
  // homepage's HTML and the site is blank with `Unexpected token '<'`.
  const exempt = [
    ...read(REDIRECTS).matchAll(/^(\/\S*?)\/\*\s+\S+\s+200!/gm),
  ].map(([, prefix]) => prefix + "/");

  const assets = [
    ...read(LAYOUT).matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="(\/[^"]*)"/g),
  ].map(([, url]) => url);

  assert.ok(assets.length > 0, "found no local assets in base.njk");

  assets.forEach((url) =>
    assert.ok(
      exempt.some((prefix) => url.startsWith(prefix)),
      `base.njk loads ${url}, which no forced rule in _redirects exempts, so ` +
        `the catch-all answers it with index.html`
    )
  );
});

test("every file the bundle lists exists", () => {
  includedFiles().forEach((includePath) =>
    assert.ok(
      fs.existsSync(path.join(INCLUDES, includePath)),
      `bundle.njk lists ${includePath}, which does not exist`
    )
  );
});

test("components/index.js comes before the files that populate it", () => {
  // It is the file that creates the `Components` global and the `Components.UI`
  // / `.Home` / `.Profile` / `.List` objects every other component assigns
  // into. Order is load-bearing across the whole list; this is the edge of it
  // that turns into a TypeError on a blank page rather than something subtle.
  const files = includedFiles();
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

includedFiles().forEach((includePath) => {
  test(`${includePath} holds no Nunjucks delimiter`, () => {
    const lines = read(path.join(INCLUDES, includePath)).split("\n");

    lines.forEach((line, i) => {
      DELIMITERS.forEach(([delimiter, pattern]) =>
        assert.ok(
          !pattern.test(line),
          `${includePath}:${i + 1} contains ${delimiter}, which Nunjucks ` +
            `reads as a template delimiter and swallows:\n  ${line.trim()}`
        )
      );
    });
  });
});

test("the concatenated bundle parses as JavaScript", () => {
  // Mirrors the js() macro in bundle.njk, which the test above pins. `new
  // Function` compiles the body without running it, so this is a syntax check
  // and nothing more — but a syntax error here is the whole site, blank.
  const bundle = includedFiles()
    .map((includePath) => {
      const source = read(path.join(INCLUDES, includePath));
      return `(() => {\n${source}\n})();\n`;
    })
    .join("");

  assert.doesNotThrow(
    () => new Function(bundle),
    "the bundle does not parse, so every page on the site would be blank"
  );
});
