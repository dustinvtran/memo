We don't have a module system, so we're creating global variables.
Every file in this directory must be added to `BUNDLED_FILES` in
`asset_plan.js`, which is the list `_data/assets.js` reads: it wraps each
file in its own IIFE, concatenates them, minifies the result and names it
after a digest of the bytes that come out. `bundle.njk` has no list of its
own to add to — it emits what `_data/assets.js` built, at the url that data
names.

A file left out of that list fails nothing. It simply is not in the bundle,
and whatever reached for its globals is `undefined` in the browser, so
`bundle.test.js` asserts that every `.js` file here is either bundled or a
`.test.js`.

Mind include order as modules may only use objects from modules which have
been included before them.
