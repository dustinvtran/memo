import films from './films/tmdb.js'
import tv from './tv_shows/tmdb.js'
import * as games from './games/igdb.js'
import * as books from './books/google.js'
/**
 * @file The adapter for each work type, keyed by the `:type` url segment.
 *
 * Exported as a named object rather than as the module itself so that
 * `useAdapters` can sit beside it. `works.test.js` is the only caller of
 * that: it used to intercept this path through `Module._load`, because the
 * three clients below were built while their modules were read and the suite
 * deliberately holds none of the keys. They are built on first use now, so
 * loading this file costs nothing and the stubs go in through an ordinary
 * seam — which is what lets the tree be ES modules at all. See
 * `docs/module_system.md`.
 */

const adapters = { films, tv, games, books }

/**
 * Replace some or all of the adapters. The suite is the only caller.
 * @type {(replacements: object) => void}
 */
const useAdapters = (replacements) => {
  Object.assign(adapters, replacements)
}

export { adapters, useAdapters }
