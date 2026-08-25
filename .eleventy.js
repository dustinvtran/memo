const HtmlMinifier = require('html-minifier-terser')

module.exports = (config) => {
  // minify the html output
  //
  // `html-minifier-terser` is the maintained fork of `html-minifier`, which
  // has had no release since 2019 and carries CVE-2022-37620. The option
  // names below are unchanged, but `minify` returns a promise where the
  // original returned a string — the `async` here is the whole of the
  // difference, and Eleventy has always awaited what a transform returns.
  config.addTransform('htmlmin', async (content, outputPath) => {
    // A transform runs over every output file, and the bundle and the
    // stylesheet are two of them now. `collapseWhitespace` over JavaScript eats
    // the newline that ends a `//` comment, and the rest of the file goes
    // with it.
    if (!outputPath || !outputPath.endsWith('.html')) return content

    return HtmlMinifier.minify(content, {
      useShortDoctype: true,
      removeComments: true,
      collapseWhitespace: true,
    })
  })

  // The bundle is concatenated, minified and hashed in `src/frontend/_data/
  // assets.js` rather than by a filter here, because its filename has to carry
  // a digest of its contents and `layouts/base.njk` needs that name before the
  // file is written. Global data is built before anything renders, so that is
  // where it can be known. `js/bundle.njk` and `css/main.njk` emit it, and the
  // dev-versus-production minification choice moved there with it.

  // pass some assets right through
  config.addPassthroughCopy('./src/frontend/img')
  config.addPassthroughCopy('./_redirects')
  // `_headers` has to sit in the publish directory to be read at all. The
  // `[[headers]]` block in `netlify.toml` is the other way to declare these and
  // it never applied on this site; see the note in the file itself.
  config.addPassthroughCopy('./_headers')

  // The bundle's sources are read by `_data/assets.js` with `fs`, so Eleventy
  // has no idea that a page depends on them. Without this, editing a component
  // under `--serve` rebuilds nothing.
  config.addWatchTarget('./src/frontend/_includes/js/')
  config.addWatchTarget('./src/frontend/_includes/css/')

  return {
    dir: {
      input: 'src/frontend',
      output: 'dist',
    },
    // No `md`. The input directory is source, not content: the only `.md`
    // files under it are README notes to whoever is reading the code, and as a
    // template format each one is a page — `src/frontend/README.md` was being
    // published at `/README/` as a layout-less fragment. Every real page here
    // is Nunjucks, so the format earns nothing back.
    templateFormats: ['njk', '11ty.js'],
    htmlTemplateEngine: false,
  }
}
