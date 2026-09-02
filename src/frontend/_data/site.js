/**
 * @file What the site says about itself, in one place, because three templates
 * say it.
 *
 * `robots.njk` needs an absolute url for its `Sitemap:` line, `sitemap.njk`
 * needs one for every `<loc>`, and `layouts/base.njk` needs the description
 * twice over — once as `<meta name="description">` and once as
 * `og:description`. Two copies of a sentence drift; one copy in global data
 * does not.
 *
 * The description is deliberately about the site rather than about a page.
 * Every url here serves the identical document — `_redirects` rewrites all of
 * them to `index.html` and the router draws the rest in the browser — so a
 * per-page description would have to be written by a server that does not
 * exist. One honest sentence beats four invented ones.
 */

/**
 * Netlify sets `URL` to the site's main address in every deploy context,
 * including deploy previews, where `DEPLOY_PRIME_URL` is the preview's own.
 * The canonical origin is the one wanted here: a sitemap listing
 * `deploy-preview-303--memo.netlify.app` would be pointing a crawler at a
 * build that stops existing.
 *
 * The fallback is what a laptop build and CI get, and it is the real domain
 * rather than `localhost` so that the emitted files are the files that ship —
 * `npm run build` on a laptop produces what Netlify produces, which is the
 * only way the check in `.github/workflows/ci.yml` means anything.
 */
const url = process.env.URL || "https://nil.moe";

module.exports = {
  url,
  title: "Memo",
  description:
    "A personal catalogue of films, TV shows, video games and books, with " +
    "scores, dates and notes. Every list is also served as JSON or Markdown " +
    "from /api/export.",
};
