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
  commonMetadata: null, // The work is referenced by workRef, not carried here
  workRef: data?.commonMetadata?.internalRef,
  overrides: getOverrides(data?.apiData, type),
  status: $('#status').val(),
  score: parseInt($('#score').val()) || null,
  completedDate: Date.parse($('#completed-date').val()) || null,
  review: $('#review').val(),
  ...(type === 'films'
    ? {}
    : { startedDate: Date.parse($('#started-date').val()) || null }),
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
  if (snapshot.status) $('#status').val(snapshot.status).trigger('change')

  $('#score').val(snapshot.score ? String(snapshot.score) : 'Unrated')
  setDate('#started-date', snapshot.startedDate)
  setDate('#completed-date', snapshot.completedDate)
  setIfPresent('#progress', snapshot.progress)
  if (snapshot.review !== undefined) $('#review').val(snapshot.review)

  OVERRIDE_FIELDS.forEach(({ id, key, isList }) => {
    if ($(`#${id}`).length === 0) return

    const override = snapshot.overrides?.[key]
    // `commonMetadata` on a list row already has the current overrides folded
    // into it, so falling back to it would leave the newer value in a field
    // the restored version didn't override. `originalData` is the cached
    // metadata as the API gave it, which is what the form falls back to.
    const fallback = data?.originalData?.[key] ?? data?.commonMetadata?.[key]
    const value = override ?? fallback

    $(`#${id}`).val(
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

const getCommaSeparated = (id) =>
  $(`#${id}`)
    .val()
    .split(',')
    .map((x) => x.trim())

const getInt = (id) => parseInt($(`#${id}`).val()) || undefined

const getIntOrNull = (id) => {
  const fieldVal = $(`#${id}`).val()
  return fieldVal === '' ? null : parseInt(fieldVal) || undefined
}

const getFloat = (id) => parseFloat($(`#${id}`).val()) || undefined

const setIfPresent = (selector, value) => {
  if ($(selector).length > 0) $(selector).val(value ?? '')
}

const setDate = (selector, timestamp) => {
  if ($(selector).length === 0) return
  $(selector).val(
    timestamp ? new Date(timestamp).toISOString().substring(0, 10) : ''
  )
}

const getOverrides = (api, type) => {
  const englishTranslatedTitle = getIfDifferent(
    api?.englishTranslatedTitle,
    $('#title').val()
  )
  const duration =
    api?.duration === getFloat('duration') * (type === 'games' ? 60 : 1)
      ? null
      : getFloat('duration') * (type === 'games' ? 60 : 1)
  getIfDifferent(api?.duration, getFloat('duration'))
  return {
    englishTranslatedTitle,
    originalTitle:
      getIfDifferent(api?.originalTitle, $('#original-title').val()) ?? null,
    releaseYear: getIfDifferent(api?.releaseYear, getIntOrNull('release-year')),
    duration,
    imageUrl: getIfDifferent(api?.imageUrl, $('#image-url').val()),
    genres: getIfDifferent(api?.genres, getCommaSeparated('genres')),
    ...(type === 'films'
      ? {
          directors: getIfDifferent(
            api?.directors,
            getCommaSeparated('directors')
          ),
          actors: getIfDifferent(api?.actors, getCommaSeparated('actors')),
        }
      : type === 'books'
      ? {
          authors: getIfDifferent(api?.authors, getCommaSeparated('authors')),
        }
      : type === 'games'
      ? {
          platforms: getIfDifferent(
            api?.platforms,
            getCommaSeparated('platforms')
          ),
          studios: getIfDifferent(api?.studios, getCommaSeparated('studios')),
          publishers: getIfDifferent(
            api?.publishers,
            getCommaSeparated('publishers')
          ),
        }
      : /* type === 'tv' */ {
          directors: getIfDifferent(
            api?.directors,
            getCommaSeparated('directors')
          ),
          actors: getIfDifferent(api?.actors, getCommaSeparated('actors')),
          episodes: getIfDifferent(api?.episodes, getInt('episodes')),
        }),
  }
}

const getIfDifferent = (apiVal, userVal) => {
  const areEqual = isArray(apiVal) ? areArraysIdentical : (a, b) => a === b
  return areEqual(apiVal, userVal) ? null : userVal || null
}

const areArraysIdentical = (arr1, arr2) => {
  const arr1NoEmpty = arr1.filter((e) => e !== '')
  const arr2NoEmpty = arr2.filter((e) => e !== '')
  return (
    arr1NoEmpty.length === arr2NoEmpty.length &&
    arr1NoEmpty.every((el, i) => arr2NoEmpty[i] === el)
  )
}
