/**
 * @file The rules behind an entry's edit history: what a saved version of an
 * entry consists of, whether two versions differ, what changed between them,
 * and how many versions we keep.
 *
 * Deliberately pure and dependency-free (no zod, no ramda, no database), so
 * it is covered by `node --test` without an install — see
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
 * @typedef {{ id: string, createdDate?: number, snapshot: object }} Version
 * @type {(current: Version, revisions: Version[]) => (Version & { isCurrent: boolean, changes: string[] })[]}
 */
const toVersionList = (current, revisions) => {
  const ordered = [
    { ...current, isCurrent: true },
    ...[...revisions].sort(byNewestFirst).map((revision) => ({
      ...revision,
      isCurrent: false,
    })),
  ]

  return ordered.map((version, index) => ({
    ...version,
    // The oldest version we hold has nothing to be compared against: we don't
    // know what the entry looked like before it, so it changed nothing.
    changes:
      index === ordered.length - 1
        ? []
        : changedFields(ordered[index + 1].snapshot, version.snapshot),
  }))
}

/**
 * The ids of the versions to drop once an entry has more than `max` of them,
 * oldest first. Keeping the newest is what matters: they are the ones an undo
 * is likely to reach for.
 * @type {(revisions: { _id: string, createdDate?: number }[], max?: number) => string[]}
 */
const revisionsToPrune = (revisions, max = MAX_REVISIONS_PER_ENTRY) =>
  [...revisions]
    .sort(byNewestFirst)
    .slice(max)
    .map(({ _id }) => _id)

export {
  REVISION_FIELDS,
  MAX_REVISIONS_PER_ENTRY,
  toSnapshot,
  changedFields,
  hasChanges,
  toVersionList,
  revisionsToPrune,
}
///////////////////////////////////////////////////////////////////////////////

const byNewestFirst = (a, b) => (b.createdDate ?? 0) - (a.createdDate ?? 0)

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
