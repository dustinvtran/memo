/**
 * @file `robots.njk` and `sitemap.njk`, rendered rather than read.
 *
 * This file exists because of a bug that every other kind of check missed.
 * #334 added named `User-agent` groups to `robots.njk`, opening the block that
 * introduces them with `{#-` — and the leading dash strips the whitespace
 * *before* a comment, so the first `User-agent: Google-Extended` was glued to
 * the end of the `#` comment line above it. The build was green, the template
 * read correctly, `Header rules` and `Redirect rules` both passed, and the
 * deployed file silently had that whole group commented out.
 *
 * Reading the template as text cannot catch that: the template is right and
 * the rendering is wrong. So these render it, with the same `site` data
 * `_data/site.js` exports, and assert the structure of what comes out.
 *
 * That is the recurring failure on this site — #302, #103, #141, #142 and
 * #157 are all "the file was written and what shipped was not what it said" —
 * and a `robots.txt` is a file whose breakage is invisible: a malformed one
 * does not error, it just quietly stops meaning what it was supposed to mean.
 *
 * Needs `nunjucks`, which Eleventy brings, so the file **skips itself** when
 * the dependencies are not installed — the convention the API suite already
 * follows.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const nunjucks = (() => {
  try {
    return require("nunjucks");
  } catch (error) {
    return undefined;
  }
})();

const options = {
  skip: nunjucks ? false : "run `npm install` to run these",
};

const site = require("./_data/site");

/**
 * The template minus its Eleventy front matter, which is `permalink` and
 * nothing this cares about, rendered with the real global data.
 */
const render = (name) => {
  const raw = fs.readFileSync(path.join(__dirname, name), "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return nunjucks.renderString(body, { site });
};

/**
 * `robots.txt` as a parser sees it: the directives of each group, keyed by the
 * agent that owns them, plus anything that arrived with no group above it.
 */
const parseRobots = (text) => {
  const groups = new Map();
  const orphans = [];
  let current;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      current = value;
      groups.set(current, groups.get(current) ?? []);
    } else if (key === "sitemap") {
      // A sitemap line is file-wide and belongs to no group, which is the one
      // directive allowed to appear without one.
      continue;
    } else if (current) {
      groups.get(current).push([key, value]);
    } else {
      orphans.push(line);
    }
  }

  return { groups, orphans };
};

///////////////////////////////////////////////////////////////////////////////

test("every directive belongs to a group", options, () => {
  // The #334 bug, stated as what a parser would see. A directive above the
  // first `User-agent:` is not merely untidy: it is a rule nothing owns, and
  // the group it was meant for has silently lost it.
  const { orphans } = parseRobots(render("robots.njk"));

  assert.deepEqual(orphans, []);
});

test("the named agents are each their own group", options, () => {
  // The whole reason they are named. A crawler that matches a named group
  // uses that group and ignores `*`, so these never have to resolve
  // `Allow: /api/export/` against `Disallow: /api/` — a precedence rule that
  // `Allow` being an extension rather than part of the 1994 standard makes
  // genuinely unsafe to rely on.
  const { groups } = parseRobots(render("robots.njk"));

  for (const agent of [
    "Google-Extended", "GPTBot", "OAI-SearchBot", "ChatGPT-User",
    "ClaudeBot", "Claude-User", "PerplexityBot", "Perplexity-User", "CCBot",
  ]) {
    assert.ok(groups.has(agent), `no group for ${agent}`);
    const directives = groups.get(agent);
    assert.ok(
      directives.some(([key, value]) => key === "allow" && value === "/api/export/"),
      `${agent} is not allowed the export`
    );
    assert.equal(
      directives.some(([key]) => key === "disallow"),
      false,
      `${agent} has a Disallow, which is the ambiguity these groups remove`
    );
  }
});

test("the catch-all still keeps the rest of the API out of a crawl budget", options, () => {
  // The named groups are additions, not a rewrite. `Disallow: /api/` is still
  // the right thing to say to everyone else, and it must survive them.
  const { groups } = parseRobots(render("robots.njk"));
  const catchAll = groups.get("*");

  assert.ok(catchAll, "no `User-agent: *` group");
  assert.ok(catchAll.some(([k, v]) => k === "disallow" && v === "/api/"));
  assert.ok(catchAll.some(([k, v]) => k === "allow" && v === "/api/export/"));
});

test("the sitemap is named, and absolutely", options, () => {
  const text = render("robots.njk");

  assert.match(text, /^Sitemap: https:\/\/[^\s]+\/sitemap\.xml$/m);
});

test("the sitemap lists the export urls, which are the only urls with data in them", options, () => {
  // #334. Every page of this site is the same empty `<div id="site">`, so a
  // sitemap of pages gives a crawler nothing to index — and a `site:` search
  // for this domain returned nothing at all. These five urls answer with the
  // data itself and need no JavaScript to read.
  const xml = render("sitemap.njk");
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url);

  assert.ok(locations.includes(`${site.url}/`), "the homepage is still listed");
  assert.ok(locations.includes(`${site.url}/api/export/${site.owner}`));
  for (const type of ["films", "tv", "games", "books"]) {
    assert.ok(
      locations.includes(`${site.url}/api/export/${type}/${site.owner}`),
      `${type} is not in the sitemap`
    );
  }
});

test("the sitemap is well formed enough to have one url per entry", options, () => {
  // A `{%- for %}` that ate a newline would produce `<loc>a</loc><loc>b</loc>`
  // on one line, which is still valid XML and still wrong to read — the same
  // class of whitespace bug this file was written for.
  const xml = render("sitemap.njk");

  assert.equal((xml.match(/<url>/g) ?? []).length, (xml.match(/<loc>/g) ?? []).length);
  assert.equal((xml.match(/<url>/g) ?? []).length, 6);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});
