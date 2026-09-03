/**
 * @file Reading the add/edit entry form into an entry, and writing an entry
 * back into the form.
 *
 * Three things need this: the submit button, which sends what the form holds;
 * the draft, which autosaves it; and the history, which puts a past version
 * back into it.
 */

/** The user's overrides, by the id of the field that holds them. */
const OVERRIDE_FIELDS = [
  { id: 'title', key: 'englishTranslatedTitle' },
  { id: 'original-title', key: 'originalTitle' },
  { id: 'release-year', key: 'releaseYear' },
  { id: 'duration', key: 'duration' },
  { id: 'image-url', key: 'imageUrl' },
  { id: 'genres', key: 'genres', isList: true },
  { id: 'directors', key: 'directors', isList: true },
  { id: 'actors', key: 'actors', isList: true },
  { id: 'authors', key: 'authors', isList: true },
  { id: 'publishers', key: 'publishers', isList: true },
  { id: 'platforms', key: 'platforms', isList: true },
  { id: 'studios', key: 'studios', isList: true },
  { id: 'episodes', key: 'episodes' },
]

/** @type {(data: any, type: string) => any} */
const readForm = (data, type) => ({
  // No `commonMetadata`: the work is referenced by `workRef` and joined on the
  // way out. Sending it as `null` was a way of saying so, but the update path
  // stored whatever it was sent, so what it actually said was "set this entry's
  // commonMetadata to null" — 3267 entries carry the field for that reason.
  // The create path never did, because `_create` parses and zod drops it. #171.
  workRef: data?.commonMetadata?.internalRef,
  overrides: getOverrides(baselineMetadata(data), type),
  status: valueOf('status'),
  score: parseInt(valueOf('score')) || null,
  completedDate: Date.parse(valueOf('completed-date')) || null,
  review: valueOf('review'),
  ...(type === 'films'
    ? {}
    : { startedDate: Date.parse(valueOf('started-date')) || null }),
  ...(type === 'tv' ? { progress: getInt('progress') || null } : {}),
})

/**
 * Puts a snapshot — a past version, or a recovered draft — back into the
 * form. Nothing is saved: the user still has to press the button, exactly as
 * they would after typing the same thing by hand.
 *
 * A field the snapshot doesn't override falls back to the cached metadata, so
 * restoring a version that had no override clears the one in the form rather
 * than leaving the newer value behind.
 *
 * @type {(snapshot: any, type: string, data?: any) => void}
 */
const writeForm = (snapshot, type, data) => {
  // Set before the rest: the status handler shows and hides the date fields,
  // and fills some of them in, so the values below must come after it.
  //
  // The event is dispatched rather than implied: assigning to `.value` from
  // script fires nothing at all, which is what `.trigger('change')` was here
  // for. It bubbles because the autosave in `draft.js` listens on the form
  // rather than on the field, and a restored version is an unsaved change like
  // any other.
  if (snapshot.status) {
    setValue('status', snapshot.status)?.dispatchEvent(
      new Event('change', { bubbles: true })
    )
  }

  setValue('score', snapshot.score ? String(snapshot.score) : 'Unrated')
  setDate('started-date', snapshot.startedDate)
  setDate('completed-date', snapshot.completedDate)
  setIfPresent('progress', snapshot.progress)
  if (snapshot.review !== undefined) setValue('review', snapshot.review)

  OVERRIDE_FIELDS.forEach(({ id, key, isList }) => {
    if (!document.getElementById(id)) return

    const override = snapshot.overrides?.[key]
    // `commonMetadata` on a list row already has the current overrides folded
    // into it, so falling back to it would leave the newer value in a field
    // the restored version didn't override. `originalData` is the cached
    // metadata as the API gave it, which is what the form falls back to.
    const fallback = data?.originalData?.[key] ?? data?.commonMetadata?.[key]
    const value = override ?? fallback

    setValue(
      id,
      value == null
        ? ''
        : isList
        ? [value].flat().join(', ')
        : key === 'duration' && type === 'games'
        ? String(value / 60)
        : String(value)
    )
  })
}

EntryFormIO = {
  readForm,
  writeForm,
}

///////////////////////////////////////////////////////////////////////////////

const { isArray } = Array

/**
 * What a field holds, or `undefined` if this entry type has no such field — a
 * film form has no started date, a book form no episode count. That is what a
 * jQuery `.val()` gave for an empty selection, and the difference from `''` is
 * one the draft comparison in `draft.js` can see: a field that is not there
 * has not been emptied.
 */
const valueOf = (id) => document.getElementById(id)?.value

/** Writes a field if this entry type has it, and answers with it either way. */
const setValue = (id, value) => {
  const field = document.getElementById(id)
  if (field) field.value = value
  return field
}

/** `?? ''` because a field that is not on this form used to throw here. */
const getCommaSeparated = (id) =>
  (valueOf(id) ?? '')
    .split(',')
    .map((x) => x.trim())

const getInt = (id) => parseInt(valueOf(id)) || undefined

const getIntOrNull = (id) => {
  const fieldVal = valueOf(id)
  return fieldVal === '' ? null : parseInt(fieldVal) || undefined
}

const getFloat = (id) => parseFloat(valueOf(id)) || undefined

const setIfPresent = (id, value) => {
  if (document.getElementById(id)) setValue(id, value ?? '')
}

const setDate = (id, timestamp) => {
  if (!document.getElementById(id)) return
  setValue(
    id,
    timestamp ? new Date(timestamp).toISOString().substring(0, 10) : ''
  )
}

/**
 * The work's metadata as the API gave it, which the form's values are compared
 * against so that only a field the user actually changed is stored.
 *
 * This used to ask for `data.apiData`, a name nothing in the frontend sets.
 * Every comparison was therefore against `undefined`, every field of the form
 * came back different, and every save wrote the whole form back as the user's
 * overrides: 5998 of the 8538 override keys in production are a copy of the
 * value they override. #317.
 *
 * The two paths that reach `readForm` carry the baseline under different
 * names, and `writeForm` above already reads both:
 *
 * - The edit path (`list.js`) hands over a row whose `commonMetadata` has the
 *   current overrides folded into it, and keeps the untouched copy beside it
 *   as `originalData`.
 * - The add path (`search_results.js`) hands over `{ commonMetadata: work }`
 *   for the work it has just retrieved. Nothing overrides it yet, so that is
 *   the untouched metadata.
 *
 * Asked with `in` rather than `??`, because `list.js` sets `originalData` on
 * every row and an entry with no work sets it to `undefined` — while that same
 * row's `commonMetadata` is built out of the entry's own overrides. Falling
 * through to it would compare every override against itself and drop the lot,
 * which for those entries is the only copy of the metadata there is.
 */
const baselineMetadata = (data) =>
  data && 'originalData' in data ? data.originalData : data?.commonMetadata

/**
 * What the form says that the work does not.
 *
 * A field holding the work's own value is not an override and is left out
 * altogether; a field the user emptied is `null`, which is how an override
 * says "the work's value is wrong and there is no replacement" — see
 * `withOverrides` in `api/utils/export_view.js`, one of the two places a
 * stored override shadows the work.
 */
const getOverrides = (work, type) => onlyOverrides(work, {
  englishTranslatedTitle: valueOf('title'),
  originalTitle: valueOf('original-title'),
  releaseYear: getIntOrNull('release-year'),
  duration: getDuration(type),
  imageUrl: valueOf('image-url'),
  genres: getCommaSeparated('genres'),
  ...(type === 'films'
    ? {
        directors: getCommaSeparated('directors'),
        actors: getCommaSeparated('actors'),
      }
    : type === 'books'
    ? {
        authors: getCommaSeparated('authors'),
      }
    : type === 'games'
    ? {
        platforms: getCommaSeparated('platforms'),
        studios: getCommaSeparated('studios'),
        publishers: getCommaSeparated('publishers'),
      }
    : /* type === 'tv' */ {
        directors: getCommaSeparated('directors'),
        actors: getCommaSeparated('actors'),
        episodes: getInt('episodes'),
      }),
})

/**
 * The duration in the unit the entry stores it in — minutes for everything,
 * though a game's field is labelled and filled in hours.
 *
 * Rounded, because the form got those hours by dividing the stored minutes and
 * multiplying them back does not always land where it started: 1975 minutes is
 * shown as 32.916666666666664 hours and returns as 1974.9999999999998, which
 * would read as an edit to a field nobody touched.
 */
const getDuration = (type) => {
  const value = getFloat('duration')
  if (value === undefined) return undefined
  return type === 'games' ? Math.round(value * 60) : value
}

/** @type {(work: any, fields: Record<string, any>) => Record<string, any>} */
const onlyOverrides = (work, fields) =>
  Object.fromEntries(
    Object.entries(fields)
      .map(([key, userVal]) => [key, asOverride(work?.[key], userVal)])
      .filter(([_key, override]) => override !== undefined)
  )

/**
 * One field: `undefined` for "not an override at all", `null` for "the user
 * cleared a value the work has", and the value itself for a real one.
 *
 * Emptying a field the work has nothing in clears nothing, so it is left out
 * rather than stored as a null — which is what put `[""]` on the `directors`
 * of 538 TV shows.
 */
const asOverride = (workVal, userVal) =>
  isBlank(userVal)
    ? isBlank(workVal)
      ? undefined
      : null
    : isSameValue(workVal, userVal)
    ? undefined
    : userVal

/** Nothing the user could have meant: no value, an empty box, an empty list. */
const isBlank = (value) =>
  value == null ||
  value === '' ||
  (typeof value === 'number' && Number.isNaN(value)) ||
  (isArray(value) && withoutBlanks(value).length === 0)

const isSameValue = (workVal, userVal) =>
  isArray(workVal) || isArray(userVal)
    ? areArraysIdentical(asList(workVal), asList(userVal))
    : workVal === userVal

/** A value the form gave as a list, compared as one; anything else as empty. */
const asList = (value) => (isArray(value) ? value : [])

const withoutBlanks = (values) => values.filter((e) => e !== '')

const areArraysIdentical = (arr1, arr2) => {
  const arr1NoEmpty = withoutBlanks(arr1)
  const arr2NoEmpty = withoutBlanks(arr2)
  return (
    arr1NoEmpty.length === arr2NoEmpty.length &&
    arr1NoEmpty.every((el, i) => arr2NoEmpty[i] === el)
  )
}
