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
 * on the way to a real query is, and so does one that would take minutes to
 * run — see `toRegexTest` and the budget in `filterEntries` for the two halves
 * of #228.
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
 *
 * The pass is on a clock. A field term is a regex the reader supplies, and
 * `?q=` means the reader can be whoever was sent a link (#156), so the pattern
 * is not necessarily anyone's own mistake: `title:(a+)+$` over 400 rows took
 * five minutes of blocked main thread, on a page that searches on load rather
 * than on a keypress (#228). Past `FILTER_BUDGET_MS` the pass gives up instead
 * of finishing.
 *
 * An abandoned pass returns **no rows**, marked for `wasAbandoned` to read.
 * The rows matched so far would be a subset of the answer wearing the answer's
 * clothes, and all of the rows would be the search silently not happening; an
 * empty list is the only one of the three a caller can tell the reader the
 * truth about, and `utils/tables.js` does.
 * @type {(rows: object[], text: string, freeTextFields: object[]) => object[]}
 */
const filterEntries = (rows, text, freeTextFields) => {
  const terms = parseQuery(text)
  if (terms.length === 0) return rows

  const deadline = Date.now() + FILTER_BUDGET_MS
  let abandoned = false
  const kept = rows.filter((row, index) => {
    // The clock bounds how many rows the pass matches, not how long one
    // `RegExp.test` takes — a catastrophic test runs to completion however
    // long that is, because nothing can interrupt it. That is the other half
    // of why `toRegexTest` refuses the explosive shapes: the budget keeps a
    // slow pattern from being minutes, and the shape check keeps a single row
    // from being minutes on its own.
    if (!abandoned && index % BUDGET_CHECK_ROWS === 0 && Date.now() > deadline) {
      abandoned = true
    }
    return abandoned ? false : matchesQuery(row, terms, freeTextFields)
  })
  return abandoned ? abandonedPass() : kept
}

/** Whether `filterEntries` gave up on that pass, rather than finding nothing. */
const wasAbandoned = (rows) => rows?.searchAbandoned === true

EntrySearch = {
  fieldFor,
  parseQuery,
  matchesQuery,
  filterEntries,
  wasAbandoned,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * How long a filtering pass gets. A real search over a real list is nowhere
 * near it — 400 rows of `title:^the` is about a millisecond — so the budget
 * only ever ends a pass that was never going to end usefully, and a quarter of
 * a second is short enough to read as a pause rather than as a freeze.
 */
const FILTER_BUDGET_MS = 250

/**
 * The clock is read every 32nd row rather than every row: `Date.now()` is
 * cheap, but so is a row that matches nothing, and the pass runs again on
 * every keystroke.
 */
const BUDGET_CHECK_ROWS = 32

/**
 * The empty result of a pass that gave up, told apart from an honest empty
 * result by the flag riding on it. A property on the array rather than a
 * wrapper object, because the caller assigns what it gets straight to
 * bootstrap-table's `this.data`.
 */
const abandonedPass = () => Object.assign([], { searchAbandoned: true })

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
 *
 * A pattern that would take minutes to *run* is treated the same way, and for
 * the same reason: `(a+)+$` compiles perfectly and then backtracks, so the
 * `catch` never sees it (#228).
 */
const toRegexTest = (value) => {
  if (hasExplosiveShape(value)) return toSubstringTest(value)
  try {
    const pattern = new RegExp(value, 'i')
    return (text) => pattern.test(text)
  } catch {
    return toSubstringTest(value)
  }
}

/**
 * The two shapes that make the engine try every way of dividing a string
 * rather than one way:
 *
 *   (a+)+   a quantifier on a group that repeats or alternates inside it
 *   a*a*b   the same atom quantified twice over, so that what one takes the
 *           other can give back
 *
 * Both are refused before they are compiled and read as text instead. This is
 * the half of #228 that answers instantly, and it is also the only half that
 * covers a pattern slow enough to hang on a single row: the budget in
 * `filterEntries` can stop a pass between rows, but nothing can interrupt one
 * `RegExp.test`, and `a*a*a*a*a*a*a*a*a*a*a*a*b` over a 40-character title
 * does not return this week.
 *
 * It over-refuses a little. `(nolan|villeneuve)+` and `\d+\d+` cannot take any
 * real time and are read as text — the answer a pattern that does not compile
 * already gets, for patterns nobody types.
 */
const hasExplosiveShape = (value) => isExplosive(toAtoms(String(value)))

const isExplosive = (atoms) =>
  atoms.some((atom, index) => {
    const previous = atoms[index - 1]
    if (previous?.text === atom.text && previous.quantifier && atom.quantifier) {
      return true
    }
    if (!isGroup(atom)) return false
    const body = bodyOf(atom)
    return (REPEATING.test(atom.quantifier) && repeats(body)) || isExplosive(body)
  })

/** A quantifier that can take what it follows more than once. */
const REPEATING = /^[*+{]/

const isGroup = (atom) => atom.text.startsWith('(')

const bodyOf = (atom) =>
  toAtoms(atom.text.replace(/^\(/, '').replace(/\)$/, ''))

/** Whether anything in there can match a given string in more than one way. */
const repeats = (atoms) =>
  atoms.some(
    (atom) =>
      atom.quantifier !== '' ||
      atom.text === '|' ||
      (isGroup(atom) && repeats(bodyOf(atom)))
  )

const QUANTIFIER = /^(?:[*+?]|\{\d*(?:,\d*)?\})\??/

/**
 * The pattern as atoms — an escape, a character class, a group, or a single
 * character — each carrying the quantifier that follows it. Reading it this
 * way is what keeps `\(a+\)+` a search for a bracket and `[a+]` a class with a
 * plus in it; `(?:` needs no special case either, because its `?` is the first
 * atom of the body rather than a quantifier on anything.
 */
const toAtoms = (source) => {
  const atoms = []
  let index = 0
  while (index < source.length) {
    const start = index
    index =
      source[index] === '\\'
        ? index + 2
        : source[index] === '['
        ? endOfClass(source, index)
        : source[index] === '('
        ? endOfGroup(source, index)
        : index + 1
    const text = source.slice(start, index)
    const [quantifier = ''] = QUANTIFIER.exec(source.slice(index)) ?? []
    index += quantifier.length
    atoms.push({ text, quantifier })
  }
  return atoms
}

/** Just past the `]` closing the class that opens at `start`, or the end. */
const endOfClass = (source, start) => {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1
    else if (source[index] === ']') return index + 1
  }
  return source.length
}

/** Just past the `)` closing the group that opens at `start`, or the end. */
const endOfGroup = (source, start) => {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1
    else if (source[index] === '[') index = endOfClass(source, index) - 1
    else if (source[index] === '(') depth += 1
    else if (source[index] === ')' && (depth -= 1) === 0) return index + 1
  }
  return source.length
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
