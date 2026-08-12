const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  statusLabel,
  toExportEntry,
  toExportList,
  toExportDocument,
  toMarkdown,
} = require('./export_view')

const film = {
  entry: {
    _id: 'e1',
    workRef: 'w1',
    userId: 'auth0|abc',
    status: 'Completed',
    score: 6,
    completedDate: 1786233600000,
    updatedDate: 1786336961244,
  },
  work: {
    _id: 'w1',
    entryType: 'Film',
    apiRefs: ['tmdb__1330435'],
    externalUrls: [{ name: 'tmdb', url: 'https://www.themoviedb.org/movie/1330435' }],
    englishTranslatedTitle: 'Ghost Killer',
    originalTitle: 'ゴーストキラー',
    releaseYear: 2025,
    duration: 105,
    genres: ['Action', 'Comedy'],
    directors: ['Kensuke Sonomura'],
  },
  review: 'A bit too zany.',
}

test('an exported entry carries what the page shows, and not the internals', () => {
  assert.deepEqual(toExportEntry('films', film), {
    id: 'e1',
    title: 'Ghost Killer',
    originalTitle: 'ゴーストキラー',
    status: 'Completed',
    score: 6,
    releaseYear: 2025,
    runtimeMinutes: 105,
    directors: ['Kensuke Sonomura'],
    genres: ['Action', 'Comedy'],
    completedDate: '2026-08-09',
    updatedDate: '2026-08-10',
    notes: 'A bit too zany.',
    url: 'https://www.themoviedb.org/movie/1330435',
  })
})

test("an override wins over the work's metadata, the way the page renders it", () => {
  const entry = toExportEntry('films', {
    ...film,
    entry: { ...film.entry, overrides: { englishTranslatedTitle: 'Ghost Killer (2025)', duration: 110 } },
  })

  assert.equal(entry.title, 'Ghost Killer (2025)')
  assert.equal(entry.runtimeMinutes, 110)
})

test('an override of null clears the field rather than shadowing the metadata with a null', () => {
  const entry = toExportEntry('films', {
    ...film,
    entry: { ...film.entry, overrides: { releaseYear: null } },
  })

  assert.equal(entry.releaseYear, 2025)
})

test('an original title that only repeats the English one is left out', () => {
  const entry = toExportEntry('films', {
    ...film,
    work: { ...film.work, originalTitle: 'Ghost Killer' },
  })

  assert.ok(!('originalTitle' in entry))
})

test('a duration of 0 is not a duration', () => {
  const entry = toExportEntry('films', { ...film, work: { ...film.work, duration: 0 } })

  assert.ok(!('runtimeMinutes' in entry))
})

test('a blank name is not a name, and a list of nothing but blanks is no list', () => {
  const entry = toExportEntry('tv', {
    entry: { _id: 't1', status: 'InProgress' },
    // What 538 of the real TV shows carry: a director field that is there but
    // says nothing.
    work: { directors: [''], actors: ['Javier Bardem', '  '] },
  })

  assert.ok(!('directors' in entry))
  assert.deepEqual(entry.actors, ['Javier Bardem'])
})

test('an empty note is left out rather than exported as an empty string', () => {
  const entry = toExportEntry('films', { ...film, review: '' })

  assert.ok(!('notes' in entry))
})

test('each type names its numbers and its people after what they are', () => {
  const game = toExportEntry('games', {
    entry: { _id: 'g1', status: 'Completed' },
    work: { duration: 1500, platforms: ['PC'], studios: ['Team Cherry'], publishers: ['Team Cherry'] },
  })
  assert.equal(game.playtimeMinutes, 1500)
  assert.deepEqual(game.platforms, ['PC'])

  const book = toExportEntry('books', {
    entry: { _id: 'b1', status: 'InProgress' },
    work: { duration: 320, authors: ['Ursula K. Le Guin'] },
  })
  assert.equal(book.pages, 320)
  assert.equal(book.status, 'Reading')
  assert.deepEqual(book.authors, ['Ursula K. Le Guin'])
})

test('a completed show has been watched through, whatever progress was last recorded', () => {
  const watched = toExportEntry('tv', {
    entry: { _id: 't1', status: 'Completed', progress: 3 },
    work: { episodes: 12 },
  })
  assert.equal(watched.episodesWatched, 12)

  const watching = toExportEntry('tv', {
    entry: { _id: 't2', status: 'InProgress', progress: 3 },
    work: { episodes: 12 },
  })
  assert.equal(watching.episodesWatched, 3)
  assert.equal(watching.status, 'Watching')
})

test('a list is ordered by status, then score, then title', () => {
  const list = toExportList('films', [
    { entry: { _id: 'a', status: 'Planned' }, work: { englishTranslatedTitle: 'Anatahan' } },
    { entry: { _id: 'b', status: 'Completed', score: 7 }, work: { englishTranslatedTitle: 'Barry Lyndon' } },
    { entry: { _id: 'c', status: 'Completed', score: 9 }, work: { englishTranslatedTitle: 'Cure' } },
    { entry: { _id: 'd', status: 'Completed', score: 9 }, work: { englishTranslatedTitle: 'Andrei Rublev' } },
  ])

  assert.equal(list.count, 4)
  assert.deepEqual(
    list.entries.map(({ title }) => title),
    ['Andrei Rublev', 'Cure', 'Barry Lyndon', 'Anatahan']
  )
})

test('a status the labels do not cover still exports, at the end', () => {
  const list = toExportList('films', [
    { entry: { _id: 'a', status: 'Whatever' }, work: { englishTranslatedTitle: 'A' } },
    { entry: { _id: 'b', status: 'Completed' }, work: { englishTranslatedTitle: 'B' } },
  ])

  assert.deepEqual(
    list.entries.map(({ status }) => status),
    ['Completed', 'Whatever']
  )
})

test('a list of a type nobody named keeps its own name', () => {
  assert.equal(toExportList('films', []).title, 'Films')
  assert.equal(statusLabel('films', 'Planned'), 'To watch')
  assert.equal(statusLabel('games', 'InProgress'), 'Playing')
})

test('the document says whose lists these are and when they were read', () => {
  const doc = toExportDocument({
    username: 'nil',
    lists: [toExportList('films', [film])],
    siteUrl: 'https://nil.moe',
    generatedAt: 1786336961244,
  })

  assert.equal(doc.user, 'nil')
  assert.equal(doc.url, 'https://nil.moe/profile/nil')
  assert.equal(doc.generatedAt, '2026-08-10T04:42:41.244Z')
  assert.equal(doc.lists[0].entries[0].title, 'Ghost Killer')
})

test('the markdown groups by status and keeps the note as it was written', () => {
  const markdown = toMarkdown(
    toExportDocument({
      username: 'nil',
      lists: [toExportList('films', [film])],
      generatedAt: 1786336961244,
    }),
    'https://nil.moe'
  )

  assert.match(markdown, /^# nil's lists$/m)
  assert.match(markdown, /^## Films \(1\) — https:\/\/nil\.moe\/films\/nil$/m)
  assert.match(markdown, /^### Completed \(1\)$/m)
  assert.match(markdown, /^#### Ghost Killer \(ゴーストキラー\) \[2025\]$/m)
  assert.match(markdown, /Score: 6\/10 · 105 min · Directed by Kensuke Sonomura/)
  assert.match(markdown, /^A bit too zany\.$/m)
})

test('an entry with nothing recorded but a title still renders', () => {
  const markdown = toMarkdown(
    toExportDocument({
      username: 'nil',
      lists: [
        toExportList('books', [
          { entry: { _id: 'b1', status: 'Planned' }, work: { englishTranslatedTitle: 'Solaris' } },
        ]),
      ],
      generatedAt: 0,
    })
  )

  assert.match(markdown, /^### To read \(1\)$/m)
  assert.match(markdown, /^#### Solaris$/m)
})
