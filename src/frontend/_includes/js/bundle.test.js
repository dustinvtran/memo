/**
 * @file The frontend bundle is built by Nunjucks `{% include %}`-ing every
 * file listed in base.njk into one inline <script>, each wrapped in its own
 * IIFE. So Nunjucks reads these .js files as templates, and anything that
 * looks like a Nunjucks delimiter is not JavaScript to it.
 *
 * When that happens nothing fails loudly: the include renders to nothing, the
 * IIFE around it loses its closing brace, and the whole 130KB bundle becomes
 * one syntax error. The build is green, the deploy is green, and every page
 * on the site is blank. A JSDoc `@typedef {{ a: string }}` cost us exactly
 * that, so the delimiters are worth a test.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LAYOUT = path.join(__dirname, "..", "layouts", "base.njk");

/** The files base.njk inlines, in the order it inlines them. */
const includedFiles = () =>
  [...fs.readFileSync(LAYOUT, "utf8").matchAll(/\{\{\s*js\("([^"]+)"\)\s*\}\}/g)]
    .map(([, includePath]) => includePath);

/** `{{ … }}` interpolates, `{% … %}` is a tag, `{# … #}` is a comment. */
const DELIMITERS = [
  ["{{", /\{\{/],
  ["{%", /\{%/],
  ["{#", /\{#/],
];

test("base.njk still inlines the frontend scripts", () => {
  assert.ok(includedFiles().length > 0, "found no js() includes in base.njk");
});

includedFiles().forEach((includePath) => {
  test(`${includePath} holds no Nunjucks delimiter`, () => {
    const file = path.join(__dirname, "..", includePath);
    const lines = fs.readFileSync(file, "utf8").split("\n");

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
