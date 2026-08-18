/**
 * @file What the search box above a list means, and which rows survive it.
 *
 * bootstrap-table's own search is a case-insensitive substring test against
 * every searchable column — hidden ones included — run over the rendered HTML
 * of the cell rather than the value behind it. Searching a film list for
 * `nolan` therefore returns Goldfinger, whose hidden cast column holds
 * Margaret Nolan, and searching for `go` returns the whole list, because
 * every linked name renders with `&go=Go` in its href.
 *
 * So this replaces it, wired up as `customSearch` in `utils/tables.js`. A
 * query is a comma-separated list of terms, all of which have to match:
 *
 *   nolan          a bare term: a case-insensitive substring, tried against
 *                  the columns the table is actually showing
 *   director:nolan a field term: a case-insensitive *regex*, tried against
 *                  that one field
 *   title:"^the ",director:nolan
 *                  both of them, and quotes keep the spaces and commas inside
 *                  them out of the parse
 *   director:      an empty field term keeps the rows that have a director at
 *                  all
 *
 * A prefix that is not a field name is not a field term — `9:00` searches for
 * `9:00`. A field value that is not a valid regex falls back to a substring
 * test rather than matching nothing, which is what every half-typed `title:^(`
 * on the way to a real query is.
 *
 * Pure: no DOM, no jQuery, no bootstrap-table. The glue is in
 * `utils/tables.js`, and `components/list/list.js` puts the query in the url.
 */

/**
 * The fields a term can name, keyed by the bootstrap-table column field they
 * belong to so that a table can ask which of its columns are searchable and
 * what each one holds.
 */
const searchFields = {
  'commonMetadata.englishTranslatedTitle': {
    names: ['title', 'name'],
    // The Title column shows the original title beside the translated one
    // when they differ, so `title:` matches either of them.
    paths: [
      'commonMetadata.englishTranslatedTitle',
      'commonMetadata.originalTitle',
    ],
  },
  'score': { names: ['score', 'preference'], paths: ['score'] },
  'commonMetadata.releaseYear': {
    names: ['year'],
    paths: ['commonMetadata.releaseYear'],
  },
  // Minutes for a film, an episode or a game, pages for a book: the number
  // that is stored, not the `2h30m` the cell draws from it.
  'commonMetadata.duration': {
    names: ['duration', 'playtime', 'pages', 'runtime'],
    paths: ['commonMetadata.duration'],
  },
  'commonMetadata.directors': {
    names: ['director', 'directors'],
    paths: ['commonMetadata.directors'],
  },
  'commonMetadata.actors': {
    names: ['actor', 'actors', 'cast'],
    paths: ['commonMetadata.actors'],
  },
  'commonMetadata.studios': {
    names: ['studio', 'studios'],
    paths: ['commonMetadata.studios'],
  },
  'commonMetadata.publishers': {
    names: ['publisher', 'publishers'],
    paths: ['commonMetadata.publishers'],
  },
  'commonMetadata.authors': {
    names: ['author', 'authors'],
    paths: ['commonMetadata.authors'],
  },
  'commonMetadata.platforms': {
    names: ['platform', 'platforms'],
    paths: ['commonMetadata.platforms'],
  },
  'commonMetadata.genres': {
    names: ['genre', 'genres'],
    paths: ['commonMetadata.genres'],
  },
  'progress': { names: ['progress'], paths: ['progress'] },
  'startedDate': {
    names: ['started', 'starteddate'],
    paths: ['startedDate'],
    asDate: true,
  },
  'completedDate': {
    names: ['completed', 'completeddate'],
    paths: ['completedDate'],
    asDate: true,
  },
  // No column of its own — each sublist is one status already — but a url
  // that describes the whole page is worth the name being spellable.
  'status': { names: ['status'], paths: ['status'] },
}

/** The field a column holds, or `undefined` for `#` and the edit button. */
const fieldFor = (columnField) => searchFields[columnField]

/**
 * Splits a query into terms and reads each one, so that the parse happens once
 * per search rather than once per row.
 * @type {(text: string) => object[]}
 */
const parseQuery = (text) => splitTerms(text).map(toTerm)

/**
 * @type {(row: object, terms: object[], freeTextFields: object[]) => boolean}
 */
const matchesQuery = (row, terms, freeTextFields) =>
  terms.every((term) =>
    (term.field ? [term.field] : freeTextFields)
      .some((field) =>
        toSearchStrings(row, field).some((value) => term.matches(value))
      )
  )

/**
 * `freeTextFields` is what a bare term is tried against — the fields of the
 * columns the table is showing. An empty query keeps the rows as they are,
 * array and all, the way bootstrap-table's own search does.
 * @type {(rows: object[], text: string, freeTextFields: object[]) => object[]}
 */
const filterEntries = (rows, text, freeTextFields) => {
  const terms = parseQuery(text)
  return terms.length === 0
    ? rows
    : rows.filter((row) => matchesQuery(row, terms, freeTextFields))
}

EntrySearch = {
  fieldFor,
  parseQuery,
  matchesQuery,
  filterEntries,
}

///////////////////////////////////////////////////////////////////////////////

/** Every name in `searchFields`, pointing at the field that offers it. */
const fieldsByName = Object.fromEntries(
  Object.values(searchFields).flatMap((field) =>
    field.names.map((name) => [name, field])
  )
)

const FIELD_TERM = /^([a-z][a-z0-9_]*)\s*:\s*([\s\S]*)$/i

/**
 * Commas separate terms, except inside a quoted value: an actor is
 * `actor:"lee, christopher"` and a title can hold a comma of its own. The
 * quotes are left in for `unquote` to take off, so that a value only loses
 * them when it is the value that was quoted.
 * @type {(text: string) => string[]}
 */
const splitTerms = (text) => {
  const terms = ['']
  let quoted = false
  for (const character of String(text ?? '')) {
    if (character === '"') quoted = !quoted
    if (character === ',' && !quoted) terms.push('')
    else terms[terms.length - 1] += character
  }
  return terms.map((term) => term.trim()).filter((term) => term !== '')
}

/**
 * A term names a field or it does not. An unknown prefix is not an error and
 * not an empty result — `9:00` and `re:zero` are things to search for, so the
 * whole term becomes the text to look for.
 */
const toTerm = (raw) => {
  const [, name, value] = FIELD_TERM.exec(raw) ?? []
  const field = name === undefined ? undefined : fieldsByName[name.toLowerCase()]
  return field
    ? { field, matches: toRegexTest(unquote(value)) }
    : { field: null, matches: toSubstringTest(unquote(raw)) }
}

const unquote = (value) =>
  value.length > 1 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value

/**
 * Anything that does not compile is treated as the text it is. Every prefix of
 * a query is typed on the way to typing the query, so `title:^the (` happens
 * to everyone who searches for a bracket, and a thrown SyntaxError there would
 * empty the page mid-keystroke.
 */
const toRegexTest = (value) => {
  try {
    const pattern = new RegExp(value, 'i')
    return (text) => pattern.test(text)
  } catch {
    return toSubstringTest(value)
  }
}

const toSubstringTest = (value) => {
  const needle = value.toLowerCase()
  return (text) => text.toLowerCase().includes(needle)
}

/** Every string of a row worth matching a term against, for one field. */
const toSearchStrings = (row, field) =>
  field.paths.flatMap((path) => toStrings(valueAt(row, path), field))

const valueAt = (row, path) =>
  path.split('.').reduce((value, key) => value?.[key], row)

const toStrings = (value, field) =>
  value === null || value === undefined
    ? []
    : Array.isArray(value)
    ? value.flatMap((each) => toStrings(each, field))
    : field.asDate
    ? [toIsoDate(value)]
    : [String(value)]

/**
 * Dates are stored as epoch milliseconds, which nobody searches for. As
 * `YYYY-MM-DD` — the same string the column draws — `completed:^2019` is a
 * year and `completed:2019-06` is a month.
 */
const toIsoDate = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toISOString().slice(0, 10)
}
