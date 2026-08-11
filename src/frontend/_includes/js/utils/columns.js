const { html } = Utils
const { round } = Math
const { apiTypeToType, statusToTitle } = Conversions

const title = () =>
  col('Title', 'commonMetadata.englishTranslatedTitle', {
    formatter: titleFormatter,
    sortable: true,
  })

// Currently unused
const status = () =>
  col('Status', 'status', {
    cellStyle: () => ({ css: { 'width': '15px' } }),
    formatter: (status, row) =>
      statusToTitle(apiTypeToType[row.commonMetadata.entryType], status) ?? status
  })

const index = () =>
  col('#', '#', {
    formatter: indexFormatter,
    visible: false,
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
    formatter: (_, row, i) => {
      // We use `onclick` and a global (window.xx) function instead of binding
      // an event, because bootstrap-table destroys the node and rebuilds it
      // when changing displayed columns
      return html`
        <i id="edit-${row.status}-${i}" class="fas fa-edit edit-button" onclick='window.editEntry(${JSON.stringify(row).replace(/'/g, `&#39;`)})'></i>
      `
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
      return `${seen}/${totalEps}`
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

Columns = {
  title,
  status,
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

  const url = externalUrls?.[0]?.url || toWikipediaUrl(englishTranslatedTitle)
  const cover = imageUrl || '/img/mawaru.png'
  const anchorId = `entry-${row.dbRef}`
  return `<span id="${anchorId}" class="title-with-cover"><img class="mini-thumb" src="${cover}"><a href="${url}">${label}</span>`
}

const englishTitleAndLastUpdatedFormatter = (_, row) => {
  const { englishTranslatedTitle } = get(row, ['englishTranslatedTitle'])
  const link = toWikipediaLink(englishTranslatedTitle, englishTranslatedTitle)
  return row.updatedDate
    ? `${link}<i style="font-size:.85em; float: right; position: relative; top: 3px;">${statusToTitle(apiTypeToType[row.commonMetadata.entryType], row.status)} ${relativeTime(row.updatedDate)}</i>`
    : link
}

const listOfLinksFormatter = (prop, toLink) => (_, row) => {
  const containerOfVal = get(row, [prop])
  const val = containerOfVal[prop]
  const transformer = toLink ?? toWikipediaLink
  return val?.map((el) => transformer(el)).join(', ') ?? ''
}

const toWikipediaLink = (name, label) =>
  `<a href="${toWikipediaUrl(name)}">${label ?? name}</a>`

const toWikipediaUrl = (name) => 
  `http://en.wikipedia.org/wiki/Special:Search?search=${name}&go=Go`

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
  const minsAsHrFraction =
    rawMins < 10 ? ''
    : rawMins < 20 ? '¼'
    : rawMins < 40 ?  '&frac12'
    : '&frac34'
  const durationText = `${hours}h${minsAsHrFraction}`
  const hltbUrl = toHltbUrl(row)
  return durationInMin && hltbUrl
    ? `<a href="${hltbUrl}">${durationText}</a>`
    : durationInMin
    ? durationText
    : '-'
}

/**
 * apiRefs are flat strings (`hltb__12345`) since the work collections were
 * flattened, so the old `{ name, ref }` lookup never matched and no playtime
 * ever linked out. Both shapes are read here, and the externalUrls entry the
 * adapter writes alongside the ref is preferred when present.
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

const makeSafeForCSS = (name) =>
  name.replace(/[^a-z0-9]/g, (s) => {
    const c = s.charCodeAt(0)
    return c == 32            ? '-' :
           c >= 65 && c <= 90 ? '_' + s.toLowerCase() :
           '__' + ('000' + c.toString(16)).slice(-4)
  })

const getOverrideOrMetadata = (prop) => (_, row) =>
  row.overrides?.[prop] ?? row.commonMetadata?.[prop]

const getOverrideOrMetadataPreserveNull = (prop) => (_, row) =>
  row.overrides?.[prop] === null ? null : (row.overrides?.[prop] ?? row.commonMetadata?.[prop])
