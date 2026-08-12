/**
 * @file A list as something other than a rendered page.
 *
 * The site draws its lists in the browser, out of `/api/entries` plus one
 * `/api/reviews` call per opened row, so anything that fetches a list url and
 * reads the HTML — a language model, a script, `curl` — gets an empty
 * `<div id="site">` and none of the data. This module turns the documents a
 * list is made of into one self-contained view of it: every entry, the note
 * included, with the internals (`workRef`, `userId`, `apiRefs`, the raw
 * override object) left out and the numbers in units a reader can use.
 *
 * Deliberately pure and dependency-free (no zod, no ramda, no database), so
 * it is covered by `node --test` without an install — see export_view.test.js.
 */

/** The `:type` segment of a list url, in the order the lists are exported. */
const ENTRY_TYPES = ['films', 'tv', 'games', 'books']

const TYPE_TITLES = {
  films: 'Films',
  tv: 'TV Shows',
  games: 'Video Games',
  books: 'Literature',
}

/**
 * Statuses in reading order — what is happening now, then what is done, then
 * what was abandoned, then what hasn't started.
 */
const STATUS_ORDER = ['InProgress', 'Completed', 'Dropped', 'Planned']

const IN_PROGRESS_LABELS = {
  films: 'Watching',
  tv: 'Watching',
  games: 'Playing',
  books: 'Reading',
}

const PLANNED_LABELS = {
  films: 'To watch',
  tv: 'To watch',
  games: 'To play',
  books: 'To read',
}

/**
 * The same wording the page's sublist headings use, so a reader of the export
 * and a reader of the site are talking about the same thing.
 * @type {(entryType: string, status: string) => string}
 */
const statusLabel = (entryType, status) =>
  ({
    InProgress: IN_PROGRESS_LABELS[entryType],
    Completed: 'Completed',
    Dropped: 'Dropped',
    Planned: PLANNED_LABELS[entryType],
  }[status]) ?? status

/**
 * One entry, flattened: the work's metadata with the user's overrides applied
 * over it (which is what the page shows), the fields that vary by type under
 * names that say what they hold, and the long note as `notes`.
 *
 * @typedef {{ entry: object, work?: object, review?: string }} RawEntry
 * @type {(entryType: string, raw: RawEntry) => object}
 */
const toExportEntry = (entryType, { entry = {}, work = {}, review }) => {
  const metadata = withOverrides(work, entry.overrides)

  return compact({
    id: entry._id,
    title: metadata.englishTranslatedTitle,
    // Only when it says something the title doesn't. A work whose original
    // title is its English one would otherwise repeat itself on every row.
    originalTitle:
      metadata.originalTitle !== metadata.englishTranslatedTitle
        ? metadata.originalTitle
        : undefined,
    status: statusLabel(entryType, entry.status),
    score: entry.score,
    releaseYear: metadata.releaseYear,
    ...typeSpecificFields(entryType, entry, metadata),
    genres: metadata.genres,
    startedDate: toDay(entry.startedDate),
    completedDate: toDay(entry.completedDate),
    updatedDate: toDay(entry.updatedDate),
    notes: review,
    url: metadata.externalUrls?.[0]?.url,
  })
}

/**
 * Every entry of one type, in the order the page stacks them: by status, then
 * by score, then by title. `count` is here so a reader can tell a short list
 * from a truncated one.
 * @type {(entryType: string, raws: RawEntry[]) => object}
 */
const toExportList = (entryType, raws = []) => {
  const entries = raws
    .map((raw) => toExportEntry(entryType, raw))
    .sort(byStatusThenScoreThenTitle(entryType))

  return {
    type: entryType,
    title: TYPE_TITLES[entryType] ?? entryType,
    count: entries.length,
    entries,
  }
}

/**
 * What the endpoint returns: the lists asked for, and enough context to say
 * whose they are and how old the numbers are.
 * @type {(args: { username: string, lists: object[], siteUrl?: string, generatedAt?: number }) => object}
 */
const toExportDocument = ({ username, lists, siteUrl, generatedAt }) => ({
  user: username,
  ...(siteUrl ? { url: `${siteUrl}/profile/${username}` } : {}),
  generatedAt: new Date(generatedAt ?? Date.now()).toISOString(),
  lists,
})

/**
 * The same document as Markdown, for a reader that would rather have prose
 * than JSON. Notes are markdown already, so they go in as they were written.
 * @type {(doc: object, siteUrl?: string) => string}
 */
const toMarkdown = (doc, siteUrl) =>
  [
    `# ${doc.user}'s lists`,
    '',
    `Exported ${doc.generatedAt}.`,
    ...doc.lists.flatMap((list) => ['', ...listToMarkdown(doc.user, list, siteUrl)]),
    '',
  ].join('\n')

module.exports = {
  ENTRY_TYPES,
  TYPE_TITLES,
  STATUS_ORDER,
  statusLabel,
  toExportEntry,
  toExportList,
  toExportDocument,
  toMarkdown,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * An override of `null` is the form's way of saying "the work's value is
 * wrong and there is no replacement" — an unknown release year, say. It must
 * not shadow the metadata with a null, which is what a plain spread would do.
 * @type {(work: object, overrides?: object) => object}
 */
const withOverrides = (work, overrides) => ({
  ...work,
  ...Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([_field, value]) => value != null)
  ),
})

/** @type {(entryType: string, entry: object, metadata: object) => object} */
const typeSpecificFields = (entryType, entry, metadata) =>
  ({
    films: {
      runtimeMinutes: toDuration(metadata.duration),
      directors: metadata.directors,
      actors: metadata.actors,
    },
    tv: {
      runtimeMinutes: toDuration(metadata.duration),
      episodes: metadata.episodes,
      // A completed show has been watched through, whatever the last recorded
      // progress was — the page counts it that way too.
      episodesWatched:
        entry.status === 'Completed' ? metadata.episodes : entry.progress,
      directors: metadata.directors,
      actors: metadata.actors,
    },
    games: {
      playtimeMinutes: toDuration(metadata.duration),
      platforms: metadata.platforms,
      studios: metadata.studios,
      publishers: metadata.publishers,
    },
    books: {
      pages: toDuration(metadata.duration),
      authors: metadata.authors,
      publishers: metadata.publishers,
    },
  }[entryType] ?? {})

/**
 * A stored duration of `0` is not a duration — it means nobody knows, the
 * same as a missing one, and the page renders both as `-`.
 * @type {(duration: any) => number | undefined}
 */
const toDuration = (duration) =>
  typeof duration === 'number' && duration > 0 ? duration : undefined

/**
 * Dates are stored as epoch milliseconds, which no reader should have to
 * decode. The day is all an entry ever meant.
 * @type {(timestamp: any) => string | undefined}
 */
const toDay = (timestamp) => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}

/**
 * Absent fields are left out rather than exported as nulls: a reader can tell
 * "this list has no genres" from "this entry has no genre" more easily when
 * the key simply isn't there.
 *
 * Empty strings inside the name lists count as absent too. A blank director
 * is invisible on the page — it renders as an empty link — but `[""]` in the
 * data reads as a director whose name is nothing, and `directors` on 538 TV
 * shows is exactly that.
 * @type {(obj: object) => object}
 */
const compact = (obj) =>
  Object.fromEntries(
    Object.entries(obj)
      .map(([field, value]) => [field, Array.isArray(value) ? withoutBlanks(value) : value])
      .filter(
        ([_field, value]) =>
          value != null &&
          value !== '' &&
          !(Array.isArray(value) && value.length === 0)
      )
  )

/** @type {(values: any[]) => any[]} */
const withoutBlanks = (values) =>
  values.filter((value) => !(typeof value === 'string' && value.trim() === ''))

/** @type {(entryType: string) => (a: object, b: object) => number} */
const byStatusThenScoreThenTitle = (entryType) => (a, b) =>
  statusRank(entryType, a.status) - statusRank(entryType, b.status) ||
  (b.score ?? -1) - (a.score ?? -1) ||
  String(a.title ?? '').localeCompare(String(b.title ?? ''))

/** @type {(entryType: string, label: string) => number} */
const statusRank = (entryType, label) => {
  const index = STATUS_ORDER.findIndex(
    (status) => statusLabel(entryType, status) === label
  )
  return index === -1 ? STATUS_ORDER.length : index
}

/** @type {(username: string, list: object, siteUrl?: string) => string[]} */
const listToMarkdown = (username, list, siteUrl) => {
  const source = siteUrl ? ` — ${siteUrl}/${list.type}/${username}` : ''

  return [
    `## ${list.title} (${list.count})${source}`,
    ...STATUS_ORDER.map((status) => statusLabel(list.type, status))
      .filter((label, index, labels) => labels.indexOf(label) === index)
      .flatMap((label) => {
        const entries = list.entries.filter((entry) => entry.status === label)
        return entries.length === 0
          ? []
          : [
              '',
              `### ${label} (${entries.length})`,
              ...entries.flatMap((entry) => entryToMarkdown(entry)),
            ]
      }),
  ]
}

/** @type {(entry: object) => string[]} */
const entryToMarkdown = (entry) => {
  const heading = [
    entry.title ?? 'Untitled',
    entry.originalTitle ? `(${entry.originalTitle})` : '',
    entry.releaseYear ? `[${entry.releaseYear}]` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const facts = [
    entry.score != null ? `Score: ${entry.score}/10` : undefined,
    entry.runtimeMinutes ? `${entry.runtimeMinutes} min` : undefined,
    entry.playtimeMinutes ? `${entry.playtimeMinutes} min played` : undefined,
    entry.pages ? `${entry.pages} pages` : undefined,
    entry.episodes ? `${entry.episodesWatched ?? 0}/${entry.episodes} episodes` : undefined,
    joinNames('Directed by', entry.directors),
    joinNames('Written by', entry.authors),
    joinNames('Starring', entry.actors),
    joinNames('By', entry.studios),
    joinNames('Published by', entry.publishers),
    joinNames('On', entry.platforms),
    joinNames('Genres:', entry.genres),
    entry.startedDate ? `started ${entry.startedDate}` : undefined,
    entry.completedDate ? `finished ${entry.completedDate}` : undefined,
    entry.url,
  ].filter(Boolean)

  return [
    '',
    `#### ${heading}`,
    ...(facts.length ? ['', facts.join(' · ')] : []),
    ...(entry.notes ? ['', entry.notes] : []),
  ]
}

/** @type {(label: string, names?: string[]) => string | undefined} */
const joinNames = (label, names) =>
  names?.length ? `${label} ${names.join(', ')}` : undefined
