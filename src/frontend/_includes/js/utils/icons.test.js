/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads icons.js into a vm context with the
 * globals it expects and pulls `GLYPHS` out of the script's scope — the same
 * shape as columns.test.js beside it.
 *
 * The real `Utils`, not a stub: what `icon` hands back is an `html` template,
 * and the escaping and the branding are most of what is being asked about
 * here, so a stand-in would be testing the stand-in.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const INCLUDES = path.join(__dirname, "..", "..");

const read = (file) => fs.readFileSync(file, "utf8");

const context = vm.createContext({ URL, console });
const load = (js, exports) =>
  vm.runInContext(`(() => {\n${js}\n;return ${exports}\n})()`, context);

load(read(path.join(__dirname, "general.js")), "undefined");
const { GLYPHS } = load(read(path.join(__dirname, "icons.js")), "({ GLYPHS })");

const { icon } = context.Icons;

// `String`, the way every caller that wants bytes rather than markup does it:
// `icon` answers with a branded value so that an `html` template can
// interpolate it without escaping the tags. See `utils/general.js`.
const render = (...args) => String(icon(...args));

test("an icon is one path, and it is the one recorded for that name", () => {
  Object.entries(GLYPHS).forEach(([name, glyph]) => {
    const markup = render(name);
    assert.equal(
      markup,
      `<svg class="icon" viewBox="${glyph.viewBox}" aria-hidden="true">` +
        `<path d="${glyph.path}"/></svg>`,
      `${name} does not draw the path the table holds for it`
    );
  });
});

test("every glyph is 512 units tall, which is what `height: 1em` rests on", () => {
  // `.icon` in `main.css` sets a height of 1em and lets the width follow from
  // the viewBox, so an icon is the size the font's glyph was. That is only
  // true while every box is Font Awesome's em square; one that is not would
  // draw at the wrong size rather than fail anything.
  Object.entries(GLYPHS).forEach(([name, glyph]) => {
    const [minX, minY, , height] = glyph.viewBox.split(" ").map(Number);
    assert.deepEqual(
      [minX, minY, height],
      [0, 0, 512],
      `${name} has viewBox "${glyph.viewBox}", which is not the em square`
    );
  });
});

test("only the attributes a caller asked for are written", () => {
  // An `id=""` or a `data-ref=""` on every icon on the page is the shape this
  // is guarding against: harmless, and then something starts selecting on it.
  assert.equal(
    render("home"),
    `<svg class="icon" viewBox="${GLYPHS.home.viewBox}" aria-hidden="true">` +
      `<path d="${GLYPHS.home.path}"/></svg>`
  );

  const full = render("edit", {
    class: "edit-button",
    id: "edit-Completed-0",
    style: "opacity:.7;",
    dataRef: "abc",
  });
  assert.match(
    full,
    /^<svg class="icon edit-button" id="edit-Completed-0" style="opacity:\.7;" data-ref="abc" viewBox=/
  );
});

test("a value a caller interpolates cannot break out of its attribute", () => {
  // `data-ref` is the entry's own `dbRef` and `id` is built out of its status,
  // so both are stored values on a page holding the reader's `nf_jwt`. `html`
  // escapes them because they are interpolated rather than literal (#272);
  // this is the assertion that they still are.
  const markup = render("edit", { dataRef: '"><script>alert(1)</script>' });

  assert.ok(!markup.includes("<script>"));
  assert.match(markup, /data-ref="&quot;&gt;&lt;script&gt;/);
});

test("an unknown name throws rather than drawing nothing", () => {
  // A silently missing icon is invisible in a screenshot and in a diff of the
  // DOM, and finding it means looking at every icon on the site.
  assert.throws(() => icon("fa-edit"), /no icon named "fa-edit"/);
  assert.throws(() => icon("pen-to-square"), /no icon named "pen-to-square"/);
});

test("every icon the bundle asks for is one this file has", () => {
  // The throw above is a runtime one, so it happens when the component holding
  // the typo is drawn — which for the modal's close button or the history
  // panel's chevron is not on any page a test opens. A misspelled name is a
  // grep away from being caught here instead.
  const walk = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  const asked = walk(path.join(INCLUDES, "js"))
    .filter((file) => file.endsWith(".js") && !file.endsWith("icons.js"))
    .flatMap((file) =>
      [...read(file).matchAll(/\bicon\(\s*'([^']+)'/g)].map(([, name]) => ({
        name,
        file: path.relative(INCLUDES, file).split(path.sep).join("/"),
      }))
    );

  assert.ok(asked.length > 0, "nothing in the bundle draws an icon any more");

  asked.forEach(({ name, file }) =>
    assert.ok(
      name in GLYPHS,
      `${file} draws an icon called "${name}", which utils/icons.js has no ` +
        `glyph for; it would throw when that component is drawn`
    )
  );
});

test("no file that reads `icon` off Icons rebinds that name", () => {
  // The failure this catches happened twice while these call sites were being
  // written, and nothing else here sees it: the name resolves, so the bundle
  // parses and every test passes, and the icon is simply a TypeError thrown
  // inside a callback at runtime. `components/list/list.js` had
  // `waitForEl(...).then((icon) => ... icon('location-arrow'))`, where the
  // element shadowed the helper, and `toStats` in the same file called its
  // separator `icon`.
  const withoutComments = (code) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const rebinds = [
    // `const icon = …`, but not the `const { icon } = Icons` that is the point
    /\b(?:const|let|var)\s+icon\b/,
    // a parameter, with or without parentheses
    /\(\s*icon\s*[,)]/,
    /,\s*icon\s*[,)]/,
    /\bicon\s*=>/,
    /\bfunction\s*\w*\s*\(\s*icon\b/,
  ];

  const offenders = fs
    .readdirSync(path.join(INCLUDES, "js"), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((file) => /\bconst\s*\{[^}]*\bicon\b[^}]*\}\s*=\s*Icons\b/.test(read(file)))
    .filter((file) => rebinds.some((pattern) => pattern.test(withoutComments(read(file)))))
    .map((file) => path.relative(INCLUDES, file).split(path.sep).join("/"));

  assert.deepEqual(
    offenders,
    [],
    "these files destructure `icon` from Icons and then bind the same name " +
      "again, which shadows the helper wherever the new binding is in scope"
  );
});

test("nothing is left reaching for the stylesheet that is gone", () => {
  // Font Awesome's CSS is not loaded any more, so an `<i class="fas fa-x">`
  // left behind anywhere is an element that draws nothing at all — the one
  // failure of this change that looks like a working page.
  const offenders = fs
    .readdirSync(path.join(INCLUDES, "js"), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((file) => !file.endsWith("icons.js") && !file.endsWith("icons.test.js"))
    .filter((file) => /class="[^"]*\bfa[srb]?\b[^"]*"/.test(read(file)))
    .map((file) => path.relative(INCLUDES, file).split(path.sep).join("/"));

  assert.deepEqual(
    offenders,
    [],
    "these files still write a Font Awesome class name, which now has no " +
      "stylesheet behind it"
  );
});
