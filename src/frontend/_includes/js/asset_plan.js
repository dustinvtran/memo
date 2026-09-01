/**
 * @file What the two hashed assets are made of and what they are called. No
 * dependencies and no I/O, so the tests can hold this without an install —
 * `_data/assets.js` does the reading and the minifying and calls in here.
 *
 * Nothing else should build one of these urls. The filename carries a digest
 * of the bytes served at it, which is the whole reason `netlify.toml` may
 * cache them `immutable`: a second place computing the name is a second place
 * for it to disagree, and a name that disagrees with its contents is a year
 * of browsers holding the wrong file.
 */
const crypto = require("node:crypto");

/**
 * The frontend's files, in the order they are concatenated.
 *
 * The order is load-bearing — a file may use globals set by the files above it
 * and not by the ones below. `js/components/index.js` is the sharp edge of it:
 * it creates the `Components` object that every component below assigns into.
 */
const BUNDLED_FILES = [
  "js/packages/neverthrow.js",
  "js/utils/general.js",
  "js/utils/icons.js",
  "js/utils/dom.js",
  "js/utils/nullable.js",
  "js/utils/deep_equal.js",
  "js/utils/load_script.js",
  "js/utils/conversions.js",
  "js/utils/http.js",
  "js/utils/netlify.js",
  "js/utils/diff.js",
  "js/utils/entry_form_io.js",
  "js/utils/review_template.js",
  "js/utils/entry_search.js",
  "js/utils/table_model.js",
  "js/utils/columns.js",
  "js/utils/table_view.js",
  "js/utils/tables.js",
  "js/components/index.js",
  "js/components/common.js",
  "js/components/with_remote_data.js",
  "js/components/ui/button.js",
  "js/components/ui/menu.js",
  "js/components/ui/input_with_action.js",
  "js/components/ui/notification.js",
  "js/components/ui/base.js",
  "js/components/ui/modal.js",
  "js/components/ui/tabbed.js",
  "js/components/home/username_setter.js",
  "js/components/profile/profile_lists.js",
  "js/components/profile/profile_stats.js",
  "js/components/profile/biography.js",
  "js/components/profile/index.js",
  "js/components/home/index.js",
  "js/components/list/add_edit_entry/buttons.js",
  "js/components/list/add_edit_entry/external_fields.js",
  "js/components/list/add_edit_entry/personal_fields.js",
  "js/components/list/add_edit_entry/cover_column.js",
  "js/components/list/add_edit_entry/draft.js",
  "js/components/list/add_edit_entry/history.js",
  "js/components/list/add_edit_entry/entry_form.js",
  "js/components/list/add_edit_entry/search_results.js",
  "js/components/list/add_edit_entry/add_entry_link.js",
  "js/components/list/list.js",
  "js/components/list/index.js",
  "js/components/router.js",
  "js/boot.js",
];

/** The stylesheet, named relative to `_includes` the way the scripts are. */
const STYLESHEET = "css/main.css";

/**
 * Each file gets its own scope. Concatenated they share one global scope, so
 * a top-level `const` in one would otherwise collide with the same name in
 * another.
 */
const wrapInIife = (source) => `(() => {\n${source}\n})();\n`;

const concatenate = (sources) => sources.map(wrapInIife).join("");

/**
 * Ten hex characters of SHA-256 over the bytes that get served. Long enough
 * that two different bundles will not land on the same name, short enough to
 * read in a network panel.
 */
const digest = (contents) =>
  crypto.createHash("sha256").update(contents, "utf8").digest("hex").slice(0, 10);

/**
 * Both urls keep the `/js/` and `/css/` prefixes, and they have to: the
 * catch-all in `_redirects` is forced, so a url is only served as itself if a
 * forced rule matches it, and those rules are written as `/js/*` and `/css/*`.
 * A hashed name that moved out of those directories would be answered with the
 * homepage's HTML.
 */
const bundleUrl = (hash) => `/js/bundle.${hash}.js`;

const stylesheetUrl = (hash) => `/css/main.${hash}.css`;

module.exports = {
  BUNDLED_FILES,
  STYLESHEET,
  wrapInIife,
  concatenate,
  digest,
  bundleUrl,
  stylesheetUrl,
};
