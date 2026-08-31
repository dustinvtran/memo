/**
 * @file Everything a list table decides, with no DOM in it: which rows survive
 * the search, what order they come out in, which columns the reader can see,
 * and which rows are open.
 *
 * This is the half of bootstrap-table worth keeping. What the library actually
 * supplied was the table markup, sort-on-header-click, the Columns dropdown and
 * expand/collapse of a detail row — 145 KB of jQuery plugin for four decisions,
 * on every page of a site that draws every list through it (#269). The search
 * was already ours (`utils/entry_search.js`), as are the columns and every cell
 * formatter.
 *
 * Split the way `CLAUDE.md` asks: the decisions are pure functions with a test
 * that runs in the no-install suite, and `utils/table_view.js` is the only part
 * that touches an element. That is also what makes this portable — this module
 * is a small, hand-rolled `@tanstack/table-core`, so a later framework
 * migration can swap it for the real one and keep the renderer's job the only
 * thing it has to rewrite.
 *
 * A state is a plain object and every transition returns a new one. Nothing
 * here reads the clock, the url or the document; `table_view.js` collects those
 * and hands them in.
 */

/**
 * A table's state, from the settings its caller wrote.
 *
 * The columns are copied with their defaults filled in, so that a `visible`
 * this module flips is its own rather than a mutation of the object
 * `utils/columns.js` built — those are rebuilt per render, but a shared one
 * would make two sublists on a page toggle together.
 * @type {(settings: object) => object}
 */
const table = ({
  columns = [],
  rows = [],
  searchText = '',
  sortField,
  sortOrder = 'asc',
}) => ({
  columns: columns.map(withColumnDefaults),
  rows,
  searchText,
  sortField,
  sortOrder,
  // `dbRef`s, in no particular order. See `withExpanded`.
  expanded: [],
})

/**
 * The same state with a new query.
 *
 * Searching closes every open comment panel, which is what bootstrap-table did
 * — it rebuilt the whole body and the detail rows went with it. Keeping them
 * open would mean re-fetching every visible review on every keystroke, since a
 * panel is filled from the network rather than from the row. The same goes for
 * the two transitions below.
 * @type {(state: object, searchText: string) => object}
 */
const withSearch = (state, searchText) =>
  ({ ...state, searchText, expanded: [] })

/**
 * The same state sorted by `field`.
 *
 * A column the table is not already sorted by starts ascending; the one it is
 * sorted by flips. That is bootstrap-table's rule, arrived at there by a
 * `column.sortOrder || column.order` whose second half defaults to `'asc'`.
 * @type {(state: object, field: string) => object}
 */
const withSortOn = (state, field) => ({
  ...state,
  sortField: field,
  sortOrder: state.sortField === field ? flip(state.sortOrder) : 'asc',
  expanded: [],
})

/** The same state with one column shown or hidden. */
/** @type {(state: object, field: string, visible: boolean) => object} */
const withColumn = (state, field, visible) => ({
  ...state,
  columns: state.columns.map((column) =>
    column.field === field ? { ...column, visible } : column
  ),
  expanded: [],
})

/**
 * The same state with one row's comment panel opened or closed.
 *
 * Rows are named by `dbRef` rather than by position, so that the set means the
 * same thing after a sort as before one.
 * @type {(state: object, dbRef: string, open: boolean) => object}
 */
const withExpanded = (state, dbRef, open) => ({
  ...state,
  expanded: open
    ? state.expanded.includes(dbRef)
      ? state.expanded
      : [...state.expanded, dbRef]
    : state.expanded.filter((ref) => ref !== dbRef),
})

const isExpanded = (state, dbRef) => state.expanded.includes(dbRef)

/** The columns with a header and a cell, in the order they are drawn. */
const visibleColumns = (state) => state.columns.filter((column) => column.visible)

/** Every column the Columns dropdown offers, shown or not. */
const switchableColumns = (state) =>
  state.columns.filter((column) => column.switchable !== false)

/**
 * The rows to draw, and whether the search gave up rather than found nothing.
 *
 * Search first, then sort, which is the order bootstrap-table ran them in and
 * the only one that makes sense: sorting rows that are about to be discarded is
 * work for nothing.
 * @type {(state: object) => { rows: object[], abandoned: boolean }}
 */
const visibleRows = (state) => {
  const matched = EntrySearch.filterEntries(
    state.rows,
    state.searchText,
    freeTextFields(state)
  )
  return { rows: sorted(matched, state), abandoned: EntrySearch.wasAbandoned(matched) }
}

/**
 * The fields a bare search term is tried against: the ones behind the columns
 * the table is *showing*.
 *
 * Hidden ones are what made `nolan` return films no Nolan worked on — the cast
 * column is hidden by default — and a row that matches on something the reader
 * cannot see is indistinguishable from a bug. Unhiding Actors has to make
 * `pacino` match immediately, which is why `withColumn` above produces a new
 * state and the caller redraws from it.
 * @type {(state: object) => object[]}
 */
const freeTextFields = (state) =>
  visibleColumns(state)
    .filter((column) => column.searchable !== false)
    .map((column) => EntrySearch.fieldFor(column.field))
    .filter((field) => field !== undefined)

/**
 * The line under an empty table.
 *
 * A pattern that backtracks is abandoned rather than run to the end, and an
 * empty list nobody explains looks exactly like a search that found nothing
 * (#228).
 */
const noMatchesText = (abandoned) =>
  abandoned
    ? 'That search was too slow to finish, so it was stopped'
    : 'No matching records found'

/**
 * The placeholder is where the field syntax is advertised: a query language
 * nothing mentions is a query language nobody types.
 */
const SEARCH_PLACEHOLDER = 'Search, e.g. director:nolan'

/** What a cell with nothing in it draws. bootstrap-table's `undefinedText`. */
const EMPTY_CELL = '-'

/**
 * The value a column names, out of a row.
 *
 * Up here with the rest of the API rather than below the divider with the
 * internals, because the object below is built as this file loads and a `const`
 * is not readable above its own definition — the same reason
 * `utils/conversions.js` keeps `indexBy` up here.
 *
 * Own properties first — `score`, `progress` and the two dates are on the entry
 * — then a dotted path, which is what `commonMetadata.releaseYear` is. A field
 * naming neither, which `#` and the edit button both do, is `undefined`, and
 * that is a column with nothing to sort or search on rather than an error.
 */
const valueAt = (row, field) =>
  Object.prototype.hasOwnProperty.call(row ?? {}, field)
    ? row[field]
    : String(field ?? '')
      .split('.')
      .reduce((value, key) => value?.[key], row)

TableModel = {
  table,
  withSearch,
  withSortOn,
  withColumn,
  withExpanded,
  isExpanded,
  visibleColumns,
  switchableColumns,
  visibleRows,
  freeTextFields,
  noMatchesText,
  valueAt,
  SEARCH_PLACEHOLDER,
  EMPTY_CELL,
}

///////////////////////////////////////////////////////////////////////////////

const withColumnDefaults = (column) => ({
  visible: true,
  searchable: true,
  sortable: false,
  switchable: true,
  ...column,
})

const flip = (order) => (order === 'desc' ? 'asc' : 'desc')

/**
 * A copy, sorted, or the rows as they came.
 *
 * The copy is not optional: an empty query hands back the caller's own array,
 * and `sort` is in place, so sorting it would reorder the list every table on
 * the page shares.
 *
 * `sort` is stable, which is what makes the alphabetical pre-sort in
 * `components/list/list.js` decide the order within one score — and in the
 * Planned sublist that is the whole of it, since almost nothing there carries a
 * preference.
 */
const sorted = (rows, { sortField, sortOrder }) => {
  if (!sortField) return rows
  const direction = sortOrder === 'desc' ? -1 : 1
  return [...rows].sort(
    (a, b) => direction * compare(valueAt(a, sortField), valueAt(b, sortField))
  )
}

/**
 * bootstrap-table's comparison, kept rather than improved on, because every
 * list on the site is currently in the order it produces.
 *
 * Absent sorts as the empty string, which puts it first ascending and last
 * descending — a Planned sublist sorted on score descending therefore ends with
 * the entries carrying no preference, as it always has. Two numbers compare as
 * numbers, so a score of 10 is above 9 rather than below it. Everything else is
 * compared as a reader would read it, which for an array of names is the
 * comma-joined string, exactly as before.
 */
const compare = (a, b) => {
  const left = a ?? ''
  const right = b ?? ''
  if (isNumeric(left) && isNumeric(right)) {
    return Math.sign(parseFloat(left) - parseFloat(right))
  }
  return String(left).localeCompare(String(right))
}

const isNumeric = (value) =>
  !Number.isNaN(parseFloat(value)) && Number.isFinite(Number(value))
