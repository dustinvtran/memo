const UglifyJS = require('uglify-js')
const HtmlMinifier = require('html-minifier')

module.exports = (config) => {
  const env = process.env.ELEVENTY_ENV

  // minify the html output
  config.addTransform('htmlmin', (content, outputPath) => {
    // A transform runs over every output file, and `/js/bundle.js` is one of
    // them now. `collapseWhitespace` over JavaScript eats the newline that
    // ends a `//` comment, and the rest of the file goes with it.
    if (!outputPath || !outputPath.endsWith('.html')) return content

    return HtmlMinifier.minify(content, {
      useShortDoctype: true,
      removeComments: true,
      collapseWhitespace: true,
    })
  })

  // compress and combine js files
  config.addFilter('jsmin', (code) => {
    // `{% set %}` hands a filter a Nunjucks SafeString, and UglifyJS reads
    // anything that is not a string as a map of filenames to sources.
    const minified = UglifyJS.minify(String(code))

    // Handing back the unminified input on failure is how a bundle that does
    // not parse gets shipped anyway. Every page on this site is drawn by that
    // one file, so a syntax error in it is a blank page on every url, with
    // nothing in the build log above it. Fail the build instead.
    if (minified.error) {
      throw new Error(`jsmin: UglifyJS could not parse the bundle: ${minified.error}`)
    }

    return minified.code
  })

  // pass some assets right through
  config.addPassthroughCopy('./src/frontend/img')
  // The stylesheet is served from `/css/main.css` rather than inlined into
  // every page, for the same reason the scripts are. It lives under
  // `_includes` because it used to be `{% include %}`d.
  config.addPassthroughCopy({
    './src/frontend/_includes/css/main.css': 'css/main.css',
  })
  config.addPassthroughCopy('./_redirects')

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
    passthroughFileCopy: true,
  }
}
