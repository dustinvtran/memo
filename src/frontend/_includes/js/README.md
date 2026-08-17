We don't have a module system, so we're creating global variables.
Every file in this directory must be added to `src/frontend/js/bundle.njk`,
which concatenates the list into `/js/bundle.js` and wraps each file in its
own IIFE. Mind include order as modules may only use objects from modules
which have been included before them.
