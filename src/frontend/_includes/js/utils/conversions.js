/**
 * @file The one description of what a work type is on the frontend: the
 * `:type` segment its urls start with, the `entryType` its documents carry,
 * and how it is spelled on a page — the list's title, the names its statuses
 * go by, and the columns its table shows.
 *
 * This used to be four restatements in three orders and three shapes:
 * `typeToTitle` / `typeToAPIType` / `apiTypeToType` here, `entryTypes` in
 * `utils/netlify.js`, `lists` in `components/router.js`, and
 * `entryTypeToFullColumns` in `utils/tables.js` — plus
 * `components/list/index.js` asking `typeToTitle[entryType]`, using the titles
 * object as a membership test because it happened to have the right keys.
 * Adding a type meant finding all five, and a missed one failed at a different
 * depth depending on which: a 404 page from the router, a profile silently one
 * list short from `netlify.js`, `undefined` and a bootstrap-table throw from
 * `tables.js`. See #221.
 *
 * `src/api/utils/work_types.js` is this same table one layer down, and it is
 * the authority for what `/api/entries/:type` accepts. This is not derived
 * from it: the bundle has no module system, so it cannot require across the
 * tree. #221 describes generating the shared half at build time through
 * `_data/assets.js`, which is the version that actually closes that gap, and
 * #24 — a real bundler — is the general answer to why this is awkward at all.
 */

/**
 * In the order the site presents them, which is the order `work_types.js`
 * already documents itself as using. The three old orders — films-first here,
 * games-first in `netlify.js`, games-then-tv in `router.js` — meant nothing,
 * but one of them was visible: `entryTypes` is the order a profile page stacks
 * its lists in.
 *
 * `apiType` is the `entryType` an entry document carries. The frontend calls
 * both sides of this conversion `entryType` depending on the file, which is
 * the frontend's half of #220 and is left alone here.
 *
 * `statusTitles` carries only the two statuses that read differently per type.
 * `Completed` and `Dropped` say the same thing about a film as about a book,
 * so they are named once below rather than four times here.
 *
 * `columns` is a function for two reasons. It depends on `status` — and it
 * reaches for `Columns`, which `js/utils/columns.js` sets *below* this file in
 * the bundle. Deferring that lookup to call time is what makes the backwards
 * reference legal, so nothing may call `columns` while the bundle is still
 * loading. `bundle.test.js` asserts the rest of the order.
 */
const WORK_TYPES = [
  {
    type: 'films',
    apiType: 'Film',
    title: 'Films',
    statusTitles: { InProgress: 'Watching', Planned: 'To watch' },
    columns: (status) => [
      Columns.index(),
      Columns.title(),
      Columns.score(status),
      Columns.year(),
      Columns.duration(),
      Columns.directors(),
      Columns.actors(),
      Columns.date('Completed Date', 'completedDate'),
    ],
  },
  {
    type: 'tv',
    apiType: 'TVShow',
    title: 'TV Shows',
    statusTitles: { InProgress: 'Watching', Planned: 'To watch' },
    columns: (status) => [
      Columns.index(),
      Columns.title(),
      Columns.score(status),
      Columns.year(),
      Columns.progress(),
      Columns.duration(),
      Columns.directors(),
      Columns.actors(),
      Columns.date('Started Date', 'startedDate'),
      Columns.date('Completed Date', 'completedDate'),
    ],
  },
  {
    type: 'games',
    apiType: 'Game',
    title: 'Video Games',
    statusTitles: { InProgress: 'Playing', Planned: 'To play' },
    columns: (status) => [
      Columns.index(),
      Columns.title(),
      Columns.score(status),
      Columns.year(),
      Columns.playtime(status),
      Columns.platforms(),
      Columns.studios(),
      Columns.publishers(),
      Columns.date('Started Date', 'startedDate'),
      Columns.date('Completed Date', 'completedDate'),
    ],
  },
  {
    type: 'books',
    apiType: 'Book',
    title: 'Literature',
    statusTitles: { InProgress: 'Reading', Planned: 'To read' },
    columns: (status) => [
      Columns.index(),
      Columns.title(),
      Columns.score(status),
      Columns.year(),
      Columns.pages(),
      Columns.authors(),
      Columns.publishers(),
      Columns.date('Started Date', 'startedDate'),
      Columns.date('Completed Date', 'completedDate'),
    ],
  },
]

/** The `:type` url segments, in the same order. */
const TYPES = WORK_TYPES.map((workType) => workType.type)

/**
 * Whether a url segment names a list.
 *
 * A real membership test, which is the point: `components/list/index.js` asked
 * `typeToTitle[entryType]`, and an object lookup answers for `constructor` and
 * `toString` as readily as for `films`. Only the router's `lists.includes`
 * stopped `/constructor/someone` reaching the page that way.
 * @type {(type: string) => boolean}
 */
const isType = (type) => TYPES.includes(type)

/**
 * The row a `:type` url segment names, or undefined if it names none — the
 * same answer `work_types.js`'s `byType` gives, and the callers decide what an
 * unknown segment costs.
 * @type {(type: string) => object | undefined}
 */
const byType = (type) => BY_TYPE[type]

/**
 * The same row, for the code that has an entry document's `entryType` in hand
 * rather than a url.
 * @type {(apiType: string) => object | undefined}
 */
const byAPIType = (apiType) => BY_API_TYPE[apiType]

/**
 * What a status is called for a given type. Answers the two shared names
 * whatever the type is — including for a type it does not know, which is load
 * bearing: `utils/columns.js` calls this with `apiTypeToType[…]`, which is
 * undefined for an entry whose `entryType` the frontend has never heard of,
 * and that row still has to be able to say "Completed".
 * @type {(entryType: string, status: string) => string | undefined}
 */
const statusToTitle = (entryType, status) =>
  SHARED_STATUS_TITLES[status] ?? byType(entryType)?.statusTitles?.[status]

/**
 * Indexes the table by one of its fields. Null-prototype, so a lookup answers
 * for the four types and nothing else — a `:type` segment comes straight off
 * the url, and `Object.prototype` is full of keys that are not work types.
 *
 * Defined here rather than below the divider with the rest of the internals
 * because the three lookups under it are built as this file loads, and a
 * `const` is not readable above its own definition.
 * @type {(field: string, value: (workType: object) => any) => object}
 */
const indexBy = (field, value) =>
  WORK_TYPES.reduce(
    (rows, workType) => Object.assign(rows, { [workType[field]]: value(workType) }),
    Object.create(null)
  )

// The three lookup objects the rest of the bundle still destructures. Derived
// rather than written out, so the table above stays the only place a type is
// named — see the callers in `components/list/`, `components/profile/` and
// `utils/columns.js`.
const typeToTitle = indexBy('type', (workType) => workType.title)

const typeToAPIType = indexBy('type', (workType) => workType.apiType)

const apiTypeToType = indexBy('apiType', (workType) => workType.type)

Conversions = {
  WORK_TYPES,
  TYPES,
  isType,
  byType,
  byAPIType,
  typeToTitle,
  typeToAPIType,
  statusToTitle,
  apiTypeToType,
}

///////////////////////////////////////////////////////////////////////////////

/** The two statuses that read the same whatever the work is. */
const SHARED_STATUS_TITLES = {
  Completed: 'Completed',
  Dropped: 'Dropped',
}

const BY_TYPE = indexBy('type', (workType) => workType)

const BY_API_TYPE = indexBy('apiType', (workType) => workType)
