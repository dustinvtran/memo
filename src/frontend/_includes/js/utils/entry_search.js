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
 * So this replaces it. `utils/table_model.js` is what calls in here, with the
 * fields of the columns its table is showing. A query is a comma-separated list
 * of terms, all of which have to match:
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
 * Pure: no DOM, no jQuery, no table. `utils/table_model.js` is the glue, and
 * `components/list/list.js` puts the query in the url.
 */

/**
 * The fields a term can name, keyed by the `field` of the column they belong to
 * so that a table can ask which of its columns are searchable and what each one
 * holds.
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
 * array and all; `utils/table_model.js` copies before it sorts, so handing the
 * caller's own array back is safe.
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
  const kept = rows.filter((row) => {
    // The clock bounds how many rows the pass matches, not how long one
    // `RegExp.test` takes — a catastrophic test runs to completion however
    // long that is, because nothing can interrupt it. That is the other half
    // of why `toRegexTest` refuses the explosive shapes: the budget keeps a
    // slow pattern from being minutes, and the shape check keeps a single row
    // from being minutes on its own.
    //
    // It is read before *every* row rather than every 32nd, which is what
    // makes the overrun one row's worth instead of thirty-one more of them
    // (#260). That mattered by a factor of 32 in the case it is there for: a
    // row the clock cannot interrupt is exactly the row that costs seconds,
    // so sampling the clock is at its least accurate precisely when it is
    // load-bearing. A `Date.now()` against a row that reads and lowercases
    // several strings is not a cost worth sampling to avoid.
    if (!abandoned && Date.now() > deadline) abandoned = true
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
 * The empty result of a pass that gave up, told apart from an honest empty
 * result by the flag riding on it. A property on the array rather than a
 * wrapper object, so that a caller with no interest in the distinction can use
 * the return value as the list of rows it is.
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
 *   (a+)+       a quantifier on a group that repeats or alternates inside it
 *   a*a*b       the same atom quantified twice over, so that what one takes
 *               the other can give back
 *   a*b*a*b*c   the same, with the two halves of the trade interleaved rather
 *               than side by side — `b*` matches the empty string, so it does
 *               not stand between the two `a*` any more than nothing does
 *
 * All of them are refused before they are compiled and read as text instead.
 * This is the half of #228 that answers instantly, and it is also the only
 * half that covers a pattern slow enough to hang on a single row: the budget
 * in `filterEntries` can stop a pass between rows, but nothing can interrupt
 * one `RegExp.test`, and `a*a*a*a*a*a*a*a*a*a*a*a*b` over a 40-character
 * title does not return this week.
 *
 * The third shape is #260, and it is why the pair no longer has to be
 * adjacent. Requiring adjacency made the check trivial to walk around by
 * interleaving: `.*[^~]*.*[^~]*.*[^~]*.*[^~]*~` is 63 characters, needs no
 * knowledge of the list it is aimed at, and spent 51 seconds on the single
 * title `The Lord of the Rings: The Fellowship of the Ring` — one row, and
 * the exponent is the title's length.
 *
 * What replaces adjacency is `isNullable`, and the distinction it draws is
 * the one that decides the question. Two quantified atoms trade characters
 * only while nothing between them has to match something, so
 * `title:^t.*e M.*$` is still a regex — the literal `e M` pins where the
 * first `.*` ends, and the cost is the square of the title's length rather
 * than two to its power. Refusing that as well would have cost the ordinary
 * search something and bought nothing.
 *
 * It over-refuses a little. `(nolan|villeneuve)+` and `\d+\d+` cannot take
 * any real time and are read as text — the answer a pattern that does not
 * compile already gets, for patterns nobody types.
 */
const hasExplosiveShape = (value) => isExplosive(toAtoms(String(value)))

/**
 * A sequence is explosive if any one of its alternatives trades characters
 * with itself, or holds a group that is explosive in its own right.
 * Alternatives are taken apart first because `a*|a*` is two ways of matching,
 * not one way of matching twice: only atoms the engine walks through in the
 * same pass can hand each other characters back.
 */
const isExplosive = (atoms) =>
  alternativesOf(atoms).some(
    (alternative) => trades(alternative) || alternative.some(isExplosiveGroup)
  )

const isExplosiveGroup = (atom) => {
  if (!isGroup(atom)) return false
  const body = bodyOf(atom)
  return (REPEATING.test(atom.quantifier) && repeats(body)) || isExplosive(body)
}

/**
 * Whether a quantified atom in this sequence repeats one that came earlier
 * with nothing mandatory in between — the shape where a character either of
 * them could have matched can be given up by one and taken by the other, and
 * the number of ways to divide the subject between them is a power rather
 * than a product.
 *
 * The atoms still in play are the ones since the last atom that has to match
 * something, because that atom fixes a point the division cannot cross.
 * Comparing `text` is the same equality the adjacent check used: it does not
 * ask whether `[a-z]` and `\w` overlap, only whether the pattern says the
 * same thing twice, which is what an interleaved attack has to do to be one.
 */
const trades = (atoms) => {
  let sinceMandatory = new Set()
  for (const atom of atoms) {
    if (atom.quantifier !== '' && sinceMandatory.has(atom.text)) return true
    if (!isNullable(atom)) sinceMandatory = new Set()
    if (atom.quantifier !== '') sinceMandatory.add(atom.text)
  }
  return false
}

/**
 * Whether an atom can match nothing at all, so that two quantified atoms on
 * either side of it are still each other's neighbours. A quantifier with a
 * lower bound of zero says so, a zero-width assertion consumes nothing to
 * begin with, and a group is as nullable as its emptiest alternative.
 */
const isNullable = (atom) =>
  OPTIONAL.test(atom.quantifier) ||
  ZERO_WIDTH.test(atom.text) ||
  (isGroup(atom) &&
    alternativesOf(bodyOf(atom)).some((body) => body.every(isNullable)))

/** A quantifier that is happy to take nothing: `*`, `?`, `{0,3}`, `{0}`. */
const OPTIONAL = /^(?:[*?]|\{0*[,}])/

/** An atom that matches a position rather than a character. */
const ZERO_WIDTH = /^(?:[$^]|\\[bB]|\(\?<?[=!])/

/** A quantifier that can take what it follows more than once. */
const REPEATING = /^[*+{]/

const isGroup = (atom) => atom.text.startsWith('(')

const bodyOf = (atom) =>
  toAtoms(atom.text.replace(/^\(/, '').replace(/\)$/, ''))

/**
 * The alternatives of a sequence, split on the `|` atoms belonging to it
 * rather than to a group inside it — `toAtoms` has already swallowed those.
 */
const alternativesOf = (atoms) =>
  atoms.reduce(
    (alternatives, atom) => {
      if (atom.text === '|') alternatives.push([])
      else alternatives[alternatives.length - 1].push(atom)
      return alternatives
    },
    [[]]
  )

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
