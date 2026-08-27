const { html, toSafeUrl } = Utils
const { round } = Math
const { apiTypeToType, statusToTitle } = Conversions

const title = () =>
  col('Title', 'commonMetadata.englishTranslatedTitle', {
    formatter: titleFormatter,
    sortable: true,
  })

// `searchable: false` here and on `edit` below: neither column holds any of
// the entry, so a row that matched on one would have matched on its row number
// or on the hex of its id.
const index = () =>
  col('#', '#', {
    formatter: indexFormatter,
    visible: false,
    searchable: false,
    cellStyle: () => ({ css: { 'width': '15px' } })
  })

const englishTitleAndLastUpdated = () =>
  col('Title', 'commonMetadata.englishTranslatedTitle', {
    formatter: englishTitleAndLastUpdatedFormatter,
  })

const score = (status) =>
  col(status === 'Planned' ? 'Preference' : 'Score', 'score', {
    sortable: true,
    align: 'center',
    cellStyle: () => ({ css: { 'width': '25px' } })
  })

const profileScores = () =>
  col('Score', 'score', {
    sortable: true,
    align: 'center',
    cellStyle: () => ({ css: { 'width': '25px' } }),
    formatter: (score, row) =>
      row.status === 'Planned' ? '-/10' : (score ?? '-') + '/10'
  })

const year = () =>
  col('Year', 'commonMetadata.releaseYear', {
    sortable: true,
    align: 'center',
    cellStyle: () => ({ css: { 'width': '25px' } }),
    formatter: getOverrideOrMetadataPreserveNull('releaseYear')
  })

const duration = () =>
  col('Duration', 'commonMetadata.duration', {
    sortable: true,
    align: 'center',
    visible: false,
    cellStyle: () => ({ css: { 'width': '25px' } }),
    formatter: durationFormatter,
  })

const playtime = (status) =>
  col('Playtime', 'commonMetadata.duration', {
    sortable: true,
    visible: status === 'Planned',
    align: 'center',
    cellStyle: () => ({ css: { 'width': '25px' } }),
    formatter: playtimeFormatter,
  })

const pages = () =>
  col('Pages', 'commonMetadata.duration', {
    sortable: true,
    align: 'center',
    visible: false,
    cellStyle: () => ({ css: { 'width': '25px' } }),
    formatter: getOverrideOrMetadata('duration')
  })

const genre = () =>
  col('Genres', 'commonMetadata.genres', {
    sortable: true,
    formatter: listOfLinksFormatter('genres'),
    cellStyle: () => ({ css: { 'width': '250px' } }),
    visible: false,
  })

const edit = () =>
  col('<i class="fas fa-edit"></i>', 'editCol', {
    searchable: false,
    formatter: (_, row, i) => {
      // The attribute names the row rather than holding it: an owner's list
      // used to write a JSON copy of every entry — metadata, overrides and
      // all — into the markup, which on a long list was more bytes of DOM
      // than the visible table. `Rows.byRef` is filled in by `initFullTable`.
      //
      // It is a `data-` attribute rather than an inline handler calling a
      // global, which is a `script-src` violation and would have stopped the
      // button working under the policy in `_headers` (#219). The handler is
      // delegated from `document` in `components/list/list.js` — which is also
      // the reason the inline one was here: bootstrap-table destroys a row's
      // node and rebuilds it when the displayed columns change, and a handler
      // on `document` never notices that.
      //
      // Nothing is interpolated into JS any more, so the id is a string in an
      // attribute like any other and `html` escapes it like any other.
      //
      // `String`, and the same on every formatter below: bootstrap-table puts
      // what a formatter returns into the cell itself, and it wants a string.
      // An object arrives as `[object Object]`, quietly, in every row.
      return String(html`
        <i id="edit-${row.status}-${i}" class="fas fa-edit edit-button" data-ref="${row.dbRef}"></i>
      `)
    },
    cellStyle: () => ({ css: { 'width': '20px' } }),
  })

const directors = () =>
  col('Director', 'commonMetadata.directors', {
    ...sortableAndLinked('directors'),
    visible: true,
    cellStyle: () => ({ css: { 'width': '200px', } }),
  })

const actors = () =>
  col('Actors', 'commonMetadata.actors', {
    ...sortableAndLinked('actors'),
    visible: false,
    cellStyle: () => ({ css: { 'width': '250px', } }),
  })

const date = (label, field) =>
  col(label, field, {
    sortable: true,
    visible: false,
    align: 'center',
    cellStyle: () => ({ css: { 'width': '80px', } }),
    formatter: (date) => {
      try {
        return date ? (new Date(date)).toISOString().substring(0, 10) : '-'
      } catch (e) {
        console.log(`failed to parse ${date}`)
        return ''
      }
    }
  })

const progress = () =>
  col('Progress', 'progress', {
    sortable: true,
    align: 'center',
    cellStyle: () => ({ css: { 'width': '20px' } }),
    formatter: (progress, row) => {
      const totalEps = row.commonMetadata.episodes ?? '-'
      const seen = row.status === 'Completed'
        ? totalEps
        : progress ?? '-'
      return String(html`${seen}/${totalEps}`)
    }
  })

const platforms = () =>
  col('Platforms', 'commonMetadata.platforms', {
    ...sortableAndLinked('platforms'),
    visible: false,
  })

const studios = () =>
  col('Studios', 'commonMetadata.studios', {
    ...sortableAndLinked('studios'),
    cellStyle: () => ({ css: { 'width': '250px' } }),
    visible: true,
  })

const publishers = () =>
  col('Publishers', 'commonMetadata.publishers', {
    ...sortableAndLinked('publishers'),
    visible: false,
  })

const authors = () =>
  col('Authors', 'commonMetadata.authors', sortableAndLinked('authors'))

/** The rows on the page, by `dbRef`, for the handlers that only get an id. */
Rows = {
  byRef: {},
}

Columns = {
  title,
  index,
  englishTitleAndLastUpdated,
  score,
  profileScores,
  year,
  duration,
  playtime,
  genre,
  edit,
  directors,
  actors,
  date,
  progress,
  platforms,
  studios,
  publishers,
  authors,
  pages,
}

///////////////////////////////////////////////////////////////////////////////

const col = (title, field, options) => ({ title, field, ...options })

/** Gets the values of row's props in metadata, trying overrides first */
const get = (row, props) =>
  Object.fromEntries(
    props.map((prop) =>
      [prop, row.overrides?.[prop] ?? row.commonMetadata?.[prop]]
    )
  )
  

const titleFormatter = (_, row) => {
  const { originalTitle, englishTranslatedTitle, imageUrl, externalUrls } =
    get(row, [
      'originalTitle', 'englishTranslatedTitle', 'imageUrl', 'externalUrls'
    ])

  const label = originalTitle && originalTitle !== englishTranslatedTitle
    ? `${originalTitle} (${englishTranslatedTitle})`
    : englishTranslatedTitle

  // Both of these are metadata: whatever TMDB or IGDB holds, or whatever the
  // owner typed into an override. `toSafeUrl` drops any scheme we would not
  // put in an `href` or a `src`; the title falls back to a Wikipedia search
  // and the cover to the placeholder, exactly as a missing one does.
  const url = toSafeUrl(externalUrls?.[0]?.url) || toWikipediaUrl(englishTranslatedTitle)
  const cover = toSafeUrl(imageUrl) || '/img/mawaru.png'
  const anchorId = `entry-${row.dbRef}`
  // Lazily: a list is one row per work and every row carries a cover, so a
  // long one asked for a thousand full-size posters at once in order to draw
  // them sixteen pixels wide. The browser now fetches the handful that are
  // actually on screen. `.mini-thumb` fixes the size, so nothing shifts as
  // the rest arrive.
  return String(html`<span id="${anchorId}" class="title-with-cover"><img class="mini-thumb" src="${cover}" loading="lazy" decoding="async" alt=""><a href="${url}">${label}</a></span>`)
}

const englishTitleAndLastUpdatedFormatter = (_, row) => {
  const { englishTranslatedTitle } = get(row, ['englishTranslatedTitle'])
  const link = toWikipediaLink(englishTranslatedTitle, englishTranslatedTitle)
  return String(row.updatedDate
    ? html`${link}<i style="font-size:.85em; float: right; position: relative; top: 3px;">${statusToTitle(apiTypeToType[row.commonMetadata.entryType], row.status)} ${relativeTime(row.updatedDate)}</i>`
    : link)
}

// The separator is what keeps this a `join` rather than an interpolated array:
// `html` puts nothing between the elements it is handed, and these want a
// comma. Each link is already markup by then, so the join is the boundary at
// which the cell becomes a string.
const listOfLinksFormatter = (prop, toLink) => (_, row) => {
  const containerOfVal = get(row, [prop])
  const val = containerOfVal[prop]
  const transformer = toLink ?? toWikipediaLink
  return val?.map((el) => String(transformer(el))).join(', ') ?? ''
}

const toWikipediaLink = (name, label) =>
  html`<a href="${toWikipediaUrl(name)}">${label ?? name}</a>`

// A genre or a studio name is metadata like any other, and it is being put
// into a query string: without `encodeURIComponent` an `&` in it silently
// becomes another parameter, and a `"` ends the attribute it sits in.
const toWikipediaUrl = (name) =>
  `http://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(name ?? '')}&go=Go`

const sortableAndLinked = (prop, toLink) => ({
  sortable: true,
  formatter: listOfLinksFormatter(prop, toLink)
})

const durationFormatter = (_, row) => {
  const { duration: durationInMin } = get(row, ['duration'])
  const hours = Math.floor(durationInMin/60)
  const mins = durationInMin % 60
  return durationInMin
    ? `${hours}h${mins ? mins+'m' : ''}`
    : '-'
}

const playtimeFormatter = (_, row) => {
  const { duration: durationInMin } = get(row, ['duration'])
  const hours = Math.floor(durationInMin/60)
  const rawMins = durationInMin % 60
  // The fractions are entities, so they are written as literals in an `html`
  // template rather than interpolated as text — which is what makes
  // `durationText` markup, and what carries it through the link below intact.
  // The url is metadata, so it is escaped like everything else.
  const minsAsHrFraction =
    rawMins < 10 ? ''
    : rawMins < 20 ? '¼'
    : rawMins < 40 ? html`&frac12`
    : html`&frac34`
  const durationText = html`${hours}h${minsAsHrFraction}`
  const url = toSafeUrl(toPlaytimeUrl(row))
  return String(durationInMin && url
    ? html`<a href="${url}">${durationText}</a>`
    : durationInMin
    ? durationText
    : '-')
}

/**
 * The playtime links to wherever the number came from, so a reader can go and
 * see what it means. `durationSource` records that; a playtime stored before
 * we recorded it came from HowLongToBeat, which is what the absent case means.
 *
 * Every playtime gets a link, and every link points into the source that
 * measured it. Those two rules used to be one rule: a HowLongToBeat playtime
 * linked to a HowLongToBeat *game page*, and 210 games hold such a playtime
 * with no `hltb__` ref beside it to build one from, so they were the only
 * numbers on the site rendering as bare text (#201). A search of the site the
 * number came from closes that gap without weakening the second rule.
 *
 * An IGDB-sourced playtime deliberately does *not* fall back to a
 * HowLongToBeat link the game may still carry, and the fallback below is a
 * search rather than the IGDB page 206 of the 210 do have: the other site's
 * page is a fine link, but it is not where this number came from, and
 * pointing at it would invite exactly the comparison that made the two
 * disagree. IGDB's time to beat runs about 1.36x HowLongToBeat's Main Story
 * and is within 20% of it on under a third of the library
 * (docs/API_choices.md).
 *
 * IGDB needs no such fallback: `duration`, `durationSource` and the `igdb`
 * externalUrl are written by one adapter call, so a playtime from there
 * always arrives with its link.
 */
const toPlaytimeUrl = (row) => {
  const { durationSource } = get(row, ['durationSource'])
  return durationSource === 'igdb'
    ? toIgdbUrl(row)
    : toHltbUrl(row) ?? toHltbSearchUrl(row)
}

/**
 * Only the stored url, never one built from the apiRef: igdb.com's game urls
 * are slugs (`/games/hollow-knight`), not ids, so there is nothing to build
 * one out of.
 */
const toIgdbUrl = (row) => {
  const { externalUrls } = get(row, ['externalUrls'])
  return externalUrls?.find((link) => link?.name === 'igdb')?.url
}

/**
 * apiRefs are flat strings (`hltb__12345`), though some documents still hold
 * the older `{ name, ref }` objects, so both shapes are read. The
 * externalUrls entry the adapter writes alongside the ref is preferred when
 * present.
 */
const toHltbUrl = (row) => {
  const { apiRefs, externalUrls } = get(row, ['apiRefs', 'externalUrls'])

  const url = externalUrls?.find((link) => link?.name === 'hltb')?.url
  if (url) return url

  // Some games carry `hltb__N/A` rather than an id. Only a numeric id makes a
  // page that exists, so anything else is treated as no link at all.
  const ref = apiRefs
    ?.map((apiRef) =>
      typeof apiRef === 'string'
        ? apiRef.startsWith('hltb__') ? apiRef.slice('hltb__'.length) : undefined
        : apiRef?.name === 'hltb' ? String(apiRef.ref) : undefined
    )
    ?.find((hltbRef) => /^\d+$/.test(hltbRef ?? ''))

  return ref ? `https://howlongtobeat.com/game?id=${ref}` : undefined
}

/**
 * A search of HowLongToBeat for the game, for the playtimes with no
 * HowLongToBeat id to link to directly.
 *
 * The missing ids can't be fetched and stored: HowLongToBeat's API is behind
 * authentication now and every route back into it is closed
 * (docs/API_choices.md). The gap is permanent, so it is closed here rather
 * than waiting on a backfill that cannot be written.
 *
 * The url is the one the site's own search box produces. A title is metadata
 * like any other, so it is encoded rather than trusted, exactly as
 * `toWikipediaUrl` encodes a genre.
 */
const toHltbSearchUrl = (row) => {
  const { englishTranslatedTitle, originalTitle } =
    get(row, ['englishTranslatedTitle', 'originalTitle'])

  const title = englishTranslatedTitle ?? originalTitle
  return title
    ? `https://howlongtobeat.com/?q=${encodeURIComponent(title)}&t=games`
    : undefined
}

const relativeTime = (ts) => {
  const msPerMinute = 60 * 1000
  const msPerHour = msPerMinute * 60
  const msPerDay = msPerHour * 24
  const msPerMonth = msPerDay * 30
  const msPerYear = msPerDay * 365

  const elapsed = Date.now() - ts

  const [number, unit] =
    elapsed < msPerMinute ? [round(elapsed/1000), 'second'] :
    elapsed < msPerHour   ? [round(elapsed/msPerMinute), 'minute'] :
    elapsed < msPerDay    ? [round(elapsed/msPerHour), 'hour'] :
    elapsed < msPerMonth  ? [round(elapsed/msPerDay),  'day'] :
    elapsed < msPerYear   ? [round(elapsed/msPerMonth), 'month'] :
    [round(elapsed/msPerYear), 'year']

  return `${number} ${unit}${number > 1 ? 's' : ''} ago`
}

const indexFormatter = (_, __, index) => index + 1

/**
 * A stored value straight into a cell — which is to say straight into
 * innerHTML, since that is what bootstrap-table does with what a formatter
 * returns. These two were the columns with no escaping at all: an owner's
 * `overrides.duration` is whatever they typed, and a list is public.
 *
 * Absent stays absent rather than becoming the empty string, because
 * bootstrap-table draws `undefinedText` — a dash — for a cell with nothing in
 * it, and a book with no page count has always shown one.
 */
const escaped = (value) => value == null ? value : String(html`${value}`)

const getOverrideOrMetadata = (prop) => (_, row) =>
  escaped(row.overrides?.[prop] ?? row.commonMetadata?.[prop])

const getOverrideOrMetadataPreserveNull = (prop) => (_, row) =>
  row.overrides?.[prop] === null ? null : escaped(row.overrides?.[prop] ?? row.commonMetadata?.[prop])
