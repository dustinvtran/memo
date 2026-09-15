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
 * `work_types` is pure for the same reason, so importing it costs nothing.
 */

import { TYPES } from './work_types.js'
/** The `:type` segment of a list url, in the order the lists are exported. */
const LIST_TYPES = TYPES

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
 * @type {(type: string, status: string) => string}
 */
const statusLabel = (type, status) =>
  ({
    InProgress: IN_PROGRESS_LABELS[type],
    Completed: 'Completed',
    Dropped: 'Dropped',
    Planned: PLANNED_LABELS[type],
  }[status]) ?? status

/**
 * One entry, flattened: the work's metadata with the user's overrides applied
 * over it (which is what the page shows), the fields that vary by type under
 * names that say what they hold, and the long note as `notes`.
 *
 * @typedef {{ entry: object, work?: object, review?: string }} RawEntry
 * @type {(type: string, raw: RawEntry) => object}
 */
const toExportEntry = (type, { entry = {}, work = {}, review }) => {
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
    status: statusLabel(type, entry.status),
    score: entry.score,
    releaseYear: metadata.releaseYear,
    ...typeSpecificFields(type, entry, metadata),
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
 * @type {(type: string, raws: RawEntry[]) => object}
 */
const toExportList = (type, raws = []) => {
  const entries = raws
    .map((raw) => toExportEntry(type, raw))
    .sort(byStatusThenScoreThenTitle(type))

  return {
    type,
    title: TYPE_TITLES[type] ?? type,
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
 * Every url this endpoint answers at, for one user.
 *
 * One function because four things name them — the index document below, the
 * `Link` header on every export response, the `413`, and the note in the
 * index that tells a reader about `?limit=` — and four lists that have to
 * agree is the shape worth avoiding. A caller that follows any of them ends
 * up somewhere real for the same reason.
 *
 * `siteUrl` is absent when the request url could not be parsed, and the
 * relative urls that fall out of that are valid in all four places.
 * @type {(username: string, siteUrl?: string) => { index: string, lists: { type: string, title: string, url: string }[] }}
 */
const toExportUrls = (username, siteUrl = '') => ({
  index: `${siteUrl}/api/export/${username}`,
  lists: LIST_TYPES.map((type) => ({
    type,
    title: TYPE_TITLES[type] ?? type,
    url: `${siteUrl}/api/export/${type}/${username}`,
  })),
})

/**
 * What `/api/export/:username` answers with when it is asked for no particular
 * number of entries: the four lists named and counted, and the url of each.
 *
 * The lists themselves are 4.76 MB together and the largest single one is
 * 2.94 MB, so the url the README, the `<noscript>` block and `robots.txt` all
 * advertise was the one nobody should fetch first. A reader that finds this
 * knows how many entries there are before committing to downloading them, and
 * knows which url holds which — where before it learned the same thing from a
 * `413`, after the request that would have told it had already failed.
 *
 * `count` here is `countDocuments` on the entry collection, not the length of
 * anything assembled: the index costs four counted indexes rather than four
 * aggregations joined to their works and their notes, which is most of why it
 * answers in a fraction of the time.
 * @type {(args: { username: string, counts?: Object.<string, number>, siteUrl?: string, generatedAt?: number }) => object}
 */
const toExportIndex = ({ username, counts = {}, siteUrl, generatedAt }) => {
  const urls = toExportUrls(username, siteUrl)

  return {
    user: username,
    ...(siteUrl ? { url: `${siteUrl}/profile/${username}` } : {}),
    generatedAt: new Date(generatedAt ?? Date.now()).toISOString(),
    // Named, because the field a reader reaches for is `lists[].entries` and
    // here there is none. A document that says what it is beats one that
    // looks like a truncation of the other.
    document: 'index',
    note:
      'An index of the lists, without their entries. Each url below is one '
      + `list in full; ${urls.index}?limit=N is all four in one response, N `
      + 'entries of each, most recently updated first. Append ?format=md to '
      + 'any of these for Markdown instead of JSON, or ?notes=false to leave '
      + 'out the long notes, which are 69% of the bytes and carry nothing to '
      + `count — ${urls.index}?notes=false is every entry of every list, `
      + 'scores and metadata and dates, in about 1.5 MB.',
    lists: urls.lists.map(({ type, title, url }) => ({
      type,
      title,
      count: counts[type] ?? 0,
      url,
    })),
  }
}

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

/**
 * The index as Markdown. Its own function rather than a branch inside
 * `toMarkdown`, which walks `list.entries` — a field the index deliberately
 * does not have.
 * @type {(doc: object) => string}
 */
const toIndexMarkdown = (doc) =>
  [
    `# ${doc.user}'s lists`,
    '',
    `Exported ${doc.generatedAt}.`,
    '',
    doc.note,
    '',
    ...doc.lists.map((list) => `- ${list.title} (${list.count}) — ${list.url}`),
    '',
  ].join('\n')

export {
  LIST_TYPES,
  TYPE_TITLES,
  STATUS_ORDER,
  statusLabel,
  toExportEntry,
  toExportList,
  toExportUrls,
  toExportDocument,
  toExportIndex,
  toMarkdown,
  toIndexMarkdown,
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

/** @type {(type: string, entry: object, metadata: object) => object} */
const typeSpecificFields = (type, entry, metadata) =>
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
  }[type] ?? {})

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

/** @type {(type: string) => (a: object, b: object) => number} */
const byStatusThenScoreThenTitle = (type) => (a, b) =>
  statusRank(type, a.status) - statusRank(type, b.status) ||
  (b.score ?? -1) - (a.score ?? -1) ||
  String(a.title ?? '').localeCompare(String(b.title ?? ''))

/** @type {(type: string, label: string) => number} */
const statusRank = (type, label) => {
  const index = STATUS_ORDER.findIndex(
    (status) => statusLabel(type, status) === label
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
