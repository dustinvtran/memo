/**
 * @file The rules behind an entry's edit history: what a saved version of an
 * entry consists of, whether two versions differ, what changed between them,
 * and how many versions we keep.
 *
 * Deliberately pure and dependency-free (no zod, no ramda, no database), so
 * it is covered by `node --test` without an install â€” see
 * revision_history.test.js.
 */

/**
 * A version of an entry, as the user typed it. `review` lives in its own
 * collection rather than on the entry, but it is the field most worth being
 * able to recover, so a snapshot carries it alongside the rest.
 */
const REVISION_FIELDS = [
  'status',
  'score',
  'startedDate',
  'completedDate',
  'progress',
  'workRef',
  'overrides',
  'review',
]

const SIMPLE_FIELDS = REVISION_FIELDS.filter((field) => field !== 'overrides')

/** How many past versions of one entry we keep. */
const MAX_REVISIONS_PER_ENTRY = 50

/**
 * How far apart an entry's id and the date on its oldest version may be and
 * still describe the same moment. The create path stamps `updatedDate` a
 * moment before the insert that mints the id, and the id only counts whole
 * seconds, so the two land within a second of each other; the rest is slack.
 */
const SAME_MOMENT_MS = 5000

/**
 * When an entry was added, read out of its id. Entries carry no creation date
 * of their own, but an ObjectId begins with the second it was minted in, and
 * the insert on the create path is what mints it. Anything that is not an
 * ObjectId's 24 hex characters answers `null` rather than a guess.
 * @type {(entryId: unknown) => number | null}
 */
const addedDateOf = (entryId) => {
  const hex = String(entryId ?? '')
  return /^[0-9a-f]{24}$/i.test(hex) ? parseInt(hex.slice(0, 8), 16) * 1000 : null
}

/**
 * @type {(entryData?: object, reviewText?: string) => object}
 */
const toSnapshot = (entryData = {}, reviewText = undefined) => {
  const source = { ...entryData, review: reviewText ?? entryData.review }
  return Object.fromEntries(
    REVISION_FIELDS
      .filter((field) => source[field] !== undefined)
      .map((field) => [
        field,
        field === 'overrides' ? withoutEmptyValues(source[field]) : source[field],
      ])
  )
}

/**
 * The fields that differ, with an override reported as `overrides.<field>` so
 * the UI can say "you changed the title" rather than "you changed overrides".
 * @type {(before?: object, after?: object) => string[]}
 */
const changedFields = (before = {}, after = {}) => [
  ...SIMPLE_FIELDS.filter((field) => !isSame(before[field], after[field])),
  ...changedOverrides(before.overrides, after.overrides).map(
    (field) => `overrides.${field}`
  ),
]

/** @type {(before?: object, after?: object) => boolean} */
const hasChanges = (before, after) => changedFields(before, after).length > 0

/**
 * Turns the current state of an entry plus its stored past versions into the
 * list the history UI renders: newest first, each one carrying what it
 * changed relative to the version before it.
 *
 * The oldest version is also marked `isOriginal` when it is the entry exactly
 * as it was added — when its date is the moment the entry's id was minted.
 * Otherwise the history begins partway through: the entry predates it, or
 * predates `updatedDate`, and what it was added with is not known.
 *
 * @typedef {{ id: string, createdDate?: number, snapshot: object }} Version
 * @type {(current: Version, revisions: Version[], addedDate?: number | null) => (Version & { isCurrent: boolean, isOriginal: boolean, changes: string[] })[]}
 */
const toVersionList = (current, revisions, addedDate = null) => {
  const ordered = [
    { ...current, isCurrent: true },
    ...[...revisions].sort(byNewestFirst).map((revision) => ({
      ...revision,
      isCurrent: false,
    })),
  ]

  return ordered.map((version, index) => {
    const isOldest = index === ordered.length - 1
    return {
      ...version,
      isOriginal: isOldest && isSameMoment(version.createdDate, addedDate),
      // The oldest version we hold has nothing to be compared against: we
      // don't know what the entry looked like before it, so it changed
      // nothing. Its whole state is what the UI shows instead.
      changes: isOldest
        ? []
        : changedFields(ordered[index + 1].snapshot, version.snapshot),
    }
  })
}

/**
 * The ids of the versions to drop once an entry has more than `max` of them.
 * The newest are kept, because they are the ones an undo is likely to reach
 * for, and so is the oldest: it is the entry as it was added, which is where
 * the history is read from, and the one version no later save can recreate.
 * What goes is the run just after it.
 * @type {(revisions: { _id: string, createdDate?: number }[], max?: number) => string[]}
 */
const revisionsToPrune = (revisions, max = MAX_REVISIONS_PER_ENTRY) =>
  revisions.length <= max
    ? []
    : [...revisions]
        .sort(byNewestFirst)
        .slice(Math.max(max - 1, 0), -1)
        .map(({ _id }) => _id)

export {
  REVISION_FIELDS,
  MAX_REVISIONS_PER_ENTRY,
  addedDateOf,
  toSnapshot,
  changedFields,
  hasChanges,
  toVersionList,
  revisionsToPrune,
}
///////////////////////////////////////////////////////////////////////////////

const byNewestFirst = (a, b) => (b.createdDate ?? 0) - (a.createdDate ?? 0)

const isSameMoment = (date, addedDate) =>
  typeof date === 'number' &&
  typeof addedDate === 'number' &&
  Math.abs(date - addedDate) < SAME_MOMENT_MS

/**
 * A field the form left empty, one the form cleared to null and one the
 * document never had are the same absence, and must not read as an edit.
 */
const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.filter((item) => item !== '').length === 0)

const isSame = (before, after) =>
  (isEmpty(before) && isEmpty(after)) || stable(before) === stable(after)

const changedOverrides = (before, after) => {
  const cleanBefore = withoutEmptyValues(before)
  const cleanAfter = withoutEmptyValues(after)
  return [...new Set([...Object.keys(cleanBefore), ...Object.keys(cleanAfter)])]
    .filter((field) => !isSame(cleanBefore[field], cleanAfter[field]))
    .sort()
}

/**
 * The entry form writes `null` into every override the user didn't set, so a
 * snapshot that kept them would be mostly noise, and two identical saves
 * would differ whenever the form happened to send one of them as undefined.
 */
const withoutEmptyValues = (overrides) =>
  overrides && typeof overrides === 'object'
    ? Object.fromEntries(
        Object.entries(overrides).filter(([_field, value]) => !isEmpty(value))
      )
    : {}

/** Key order is not meaningful, so it must not count as a difference. */
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
