/**
 * @file The bundle and the stylesheet, as global data every template can read.
 *
 * This exists to solve an ordering problem. The filename of the bundle has to
 * carry a digest of the bundle's contents, and `layouts/base.njk` has to know
 * that filename — but `base.njk` renders before `js/bundle.njk` is written, so
 * it cannot wait for the file to exist and ask. Eleventy builds global data
 * before it renders anything, so doing the concatenation *here* puts the
 * contents and the name in hand before either template runs. `bundle.njk`
 * emits `assets.js.code` at `assets.js.url` and `base.njk` loads
 * `assets.js.url`, and neither of them computes anything.
 *
 * The concatenation moved here from Nunjucks `{% include %}`s in `bundle.njk`
 * for the same reason: the digest has to be of the bytes that are actually
 * served, so whatever assembles those bytes has to be the thing that hashes
 * them. Reading the files with `fs` rather than including them as templates
 * also takes away an old trap — Nunjucks used to parse each of these .js files
 * looking for `{{`, `{%` and `{#`, and a JSDoc brace pair once swallowed a
 * file and blanked the whole site.
 */
const fs = require("node:fs");
const path = require("node:path");
const UglifyJS = require("uglify-js");

const plan = require("../_includes/js/asset_plan");

const INCLUDES = path.join(__dirname, "..", "_includes");

const read = (relativePath) =>
  fs.readFileSync(path.join(INCLUDES, relativePath), "utf8");

// Set by both npm scripts. Anything else — a bare `eleventy`, a CI job, a
// Netlify build — is treated as production, so the fallback is the safe one.
const isDev = process.env.ELEVENTY_ENV === "dev";

const minify = (code) => {
  // Compressing and mangling 140KB is the slowest thing in the build — 300ms
  // of a 900ms run — and it buys a watch loop nothing. Parsing is the part
  // worth keeping in dev: it costs 40ms and it is what the check below reads.
  //
  // The digest is taken over whichever of the two came out, so a dev bundle
  // and a production one have different names. That is correct rather than
  // unfortunate: they are different bytes.
  const minified = isDev
    ? UglifyJS.minify(code, {
        compress: false,
        mangle: false,
        output: { beautify: true },
      })
    : UglifyJS.minify(code);

  // Handing back the unminified input on failure is how a bundle that does not
  // parse gets shipped anyway. Every page on this site is drawn by that one
  // file, so a syntax error in it is a blank page on every url, with nothing in
  // the build log above it. Fail the build instead.
  if (minified.error) {
    throw new Error(`assets: UglifyJS could not parse the bundle: ${minified.error}`);
  }

  return minified.code;
};

/**
 * A function rather than an object, so the files are re-read on every build.
 * Node caches this module, so a `--serve` rebuild would otherwise keep serving
 * whatever the first build happened to read.
 */
module.exports = () => {
  const bundle = minify(plan.concatenate(plan.BUNDLED_FILES.map(read)));
  const stylesheet = read(plan.STYLESHEET);

  return {
    js: { url: plan.bundleUrl(plan.digest(bundle)), code: bundle },
    css: { url: plan.stylesheetUrl(plan.digest(stylesheet)), code: stylesheet },
  };
};
