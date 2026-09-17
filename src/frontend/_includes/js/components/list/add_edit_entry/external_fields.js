const { html, css } = Utils
const { initComponent } = Components
const { TextInput } = Components.UI
const { isArray } = Array

/**
 * `baseline` is the work as the API gave it, and the whole reason the override
 * hint works at all.
 *
 * `commonMetadata` on a list row has the overrides folded into it — `list.js`
 * builds it that way so the table can render one value per column — so
 * comparing an override against it compares it against itself, every field
 * looks unchanged, and **the hint never appeared on the edit form at all.**
 * `originalData` is the untouched copy that `list.js` keeps beside it.
 *
 * Asked with `in` rather than `??`, for the same reason `baselineMetadata` in
 * utils/entry_form_io.js is: an entry with no work sets `originalData` to
 * `undefined` while its `commonMetadata` is built out of its own overrides, so
 * falling through would compare every override against itself and report a
 * work that is not there. It is the #317 mistake in a second place.
 */
const ExternalFields = (row, type) => {
  const { commonMetadata, overrides } = row ?? {}
  const data = row && 'originalData' in row ? row.originalData : commonMetadata
  const Input = (label, id, prop, transformer, type) => {
    const propName = prop ?? id
    const joinIfArray = x => isArray(x) ? x.join(', ') : x
    const transformerFn = transformer ?? (x => x)
    const fromDb = transformerFn(joinIfArray(data?.[propName]))
    const override = transformerFn(joinIfArray(overrides?.[propName]))
    const isOverridden = fromDb != null && override != null && override !== fromDb
    const valToShow = override ?? fromDb

    return initComponent({
      content: ({ include }) => html`
        <div style="margin: 15px 0">
          ${include(TextInput({ label, id, defaultValue: valToShow, type }))}
          ${isOverridden ?
              html`<div class="override-hint">You have overriden this field.<br>Database value: <strong>${fromDb}</strong></div>`
          : ''}
        </div>
      `,
      style: () => css`
        .override-hint {
          font-size: 10px;
          margin-top: 4px;
          color: #E0480E;
        }
      `,
    })
  }

  const durationUnit =
    type === 'books' ? 'pages' :
    type === 'tv'    ? 'minutes per ep' :
    type === 'games' ? 'hours' :
    /* type films */   'minutes'

  const filmFields = [
    Input('Director(s) (comma-separated)', 'directors'),
    Input('Actors (comma-separated)', 'actors'),
  ]

  const bookFields = [
    Input('Author(s) (comma-separated)', 'authors'),
    Input('Publishers (comma-separated)', 'publishers'),
  ]

  const gameFields = [
    Input('Platforms (comma-separated)', 'platforms'),
    Input('Studios (comma-separated)', 'studios'),
    Input('Publishers (comma-separated)', 'publishers'),
  ]

  const tvFields = [
    Input('Director(s) (comma-separated)', 'directors'),
    Input('Actors (comma-separated)', 'actors'),
    Input('Episodes', 'episodes'),
  ]

  return initComponent({
    content: ({ include }) => html`
      <div id="external-fields" style="width: 200px">
        ${include([
          Input('Title', 'title', 'englishTranslatedTitle'),
          Input('Original title', 'original-title', 'originalTitle'),
          Input('Release year', 'release-year', 'releaseYear', undefined, 'number'),
          Input(
            `Duration (${durationUnit})`,
            'duration',
            undefined,
            type === 'games'
              ? (x => x ? (x / 60) : undefined)
              : (x => x),
            'number'
          ),
          Input('Image URL', 'image-url', 'imageUrl'),
          Input('Genres (comma-separated)', 'genres'),
          ...(
            type === 'films' ? filmFields :
            type === 'books' ? bookFields :
            type === 'games' ? gameFields :
            /* type tv */      tvFields
          ),
        ])}
      </div>
    `
  })
}

Components.List.ExternalFields = ExternalFields
