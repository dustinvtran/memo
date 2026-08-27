/**
 * @file The edit history of an entry, inside the edit form.
 *
 * A timeline of versions, newest first. Each row is one save, showing when it
 * happened and which fields it touched; opening a row shows the old and new
 * value of each, and a line diff of the comments. "Restore into form" puts a
 * version back into the fields without saving, so restoring is an ordinary
 * edit that can be looked at before it is committed to, and is itself
 * undoable.
 *
 * Collapsed by default and one row at a time: an entry saved fifty times
 * should still be readable in a modal.
 */
const { html, css, timeAgo, dateTime, dateOnly } = Utils
const { initComponent, setContent, WithRemoteData } = Components
const { showNotification } = Components.UI
const { getVersions } = Netlify
const { writeForm } = EntryFormIO
const { lineDiff, diffSummary } = Diff

const EntryHistory = (type, data) => initComponent({
  content: ({ id }) => html`
    <div class="entry-history">
      <div id="${id}-header" class="history-header">
        <i class="fas fa-clock-rotate-left history-icon"></i>
        <span class="history-title">History</span>
        <span id="${id}-count" class="history-count"></span>
        <i id="${id}-chevron" class="fas fa-chevron-down history-chevron"></i>
      </div>
      <div id="${id}-body" class="history-body" style="display: none;"></div>
    </div>
  `,
  style: () => historyStyle,
  initializer: ({ id }) => {
    let loaded = false

    $(`#${id}-header`).click(() => {
      $(`#${id}-body`).slideToggle(150)
      $(`#${id}-chevron`).toggleClass('is-open')

      if (loaded) return
      loaded = true

      setContent(`#${id}-body`, WithRemoteData({
        remoteData: getVersions(type, data.dbRef),
        component: ({ versions }) => {
          const past = (versions ?? []).length - 1
          $(`#${id}-count`).text(
            past === 0 ? 'no edits yet' : past === 1 ? '1 earlier version' : `${past} earlier versions`
          )
          return Versions(type, data, versions ?? [])
        },
      }))
    })
  },
})

Components.List.EntryHistory = EntryHistory

///////////////////////////////////////////////////////////////////////////////

const Versions = (type, data, versions) => initComponent({
  content: ({ include }) =>
    versions.length <= 1
      ? html`
        <div class="history-empty">
          Nothing has been changed yet. The next time you save this entry, the
          version you replaced will show up here.
        </div>
      `
      : html`
        <ol class="version-list">
          ${include(
            versions.map((version, index) =>
              Version(type, data, version, versions[index + 1])
            )
          )}
        </ol>
      `,
})

const Version = (type, data, version, older) => initComponent({
  content: ({ id }) => html`
    <li class="version ${version.isCurrent ? 'is-current' : ''}">
      <div id="${id}-row" class="version-row">
        <span class="version-dot"></span>
        <span class="version-when" title="${dateTime(version.createdDate)}">
          ${timeAgo(version.createdDate)}
        </span>
        ${version.isCurrent ? html`<span class="version-tag">current</span>` : ''}
        <span class="version-chips">${chipsHtml(version, older)}</span>
        <i id="${id}-caret" class="fas fa-chevron-down version-caret"></i>
      </div>
      <div id="${id}-detail" class="version-detail" style="display: none;">
        ${changesHtml(version, older)}
        ${version.isCurrent
          ? ''
          : html`
            <div class="version-actions">
              <button type="button" id="${id}-restore" class="restore-button">
                Restore into form
              </button>
            </div>
          `}
      </div>
    </li>
  `,
  initializer: ({ id }) => {
    $(`#${id}-row`).click(() => {
      const wasOpen = $(`#${id}-detail`).is(':visible')

      // One row open at a time: two open diffs in a modal push each other off
      // the screen.
      $(`#${id}-detail`).closest('.version-list').find('.version-detail').slideUp(120)
      $(`#${id}-row`).closest('.version-list').find('.version-caret').removeClass('is-open')

      if (!wasOpen) {
        $(`#${id}-detail`).slideDown(120)
        $(`#${id}-caret`).addClass('is-open')
      }
    })

    $(`#${id}-restore`).click((event) => {
      // The row's own handler would fold the detail shut underneath the click.
      event.stopPropagation()
      writeForm(version.snapshot, type, data)
      window.hasUnsavedChange = true
      showNotification(
        `Loaded the version from ${timeAgo(version.createdDate)} into the ` +
          `form. Nothing is saved until you press "Edit entry".`
      )
    })
  },
})

/** The fields a version touched, as chips — the summary you scan. */
const chipsHtml = (version, older) => {
  if (version.changes.length === 0) {
    return html`<span class="version-chip is-quiet">${
      older ? 'no change' : 'first version'
    }</span>`
  }

  const shown = version.changes.slice(0, MAX_CHIPS)
  const rest = version.changes.length - shown.length

  return html`${shown.map((field) => html`<span class="version-chip">${fieldLabel(field)}</span>`)}${
    rest > 0 ? html`<span class="version-chip is-quiet">+${rest} more</span>` : ''
  }`
}

const changesHtml = (version, older) => {
  if (version.changes.length === 0) {
    return html`<div class="version-note">${
      older
        ? 'This save changed none of the fields kept in the history.'
        : 'The earliest version recorded. What came before it is unknown.'
    }</div>`
  }

  const fields = version.changes.filter((field) => field !== 'review')
  const hasReview = version.changes.includes('review')

  return html`${
    fields.length > 0
      ? html`<table class="field-changes">${
          fields.map((field) => fieldRowHtml(field, version, older))
        }</table>`
      : ''
  }${hasReview ? reviewDiffHtml(version, older) : ''}`
}

const fieldRowHtml = (field, version, older) => html`
  <tr>
    <td class="field-name">${fieldLabel(field)}</td>
    <td class="field-old">${formatValue(field, valueOf(older?.snapshot, field))}</td>
    <td class="field-arrow"><i class="fas fa-arrow-right"></i></td>
    <td class="field-new">${formatValue(field, valueOf(version.snapshot, field))}</td>
  </tr>
`

const reviewDiffHtml = (version, older) => {
  const lines = lineDiff(older?.snapshot?.review, version.snapshot.review)
  const { added, removed } = diffSummary(lines)

  return html`
    <div class="review-diff">
      <div class="review-diff-header">
        <span class="field-name">Comments</span>
        <span class="diff-added">+${added}</span>
        <span class="diff-removed">&minus;${removed}</span>
      </div>
      <div class="review-diff-body">
        ${withCollapsedContext(lines).map(diffLineHtml)}
      </div>
    </div>
  `
}

/**
 * A long note is mostly unchanged, and scrolling past it to find the one
 * edited paragraph defeats the point. Runs of untouched lines are folded down
 * to a little context on either side.
 */
const CONTEXT_LINES = 2

const withCollapsedContext = (lines) => {
  const isChanged = (line) => line.type !== 'same'
  const nextChangeFrom = (index) => lines.findIndex((line, at) => at >= index && isChanged(line))
  const lastChangeBefore = (index) =>
    lines.reduce((last, line, at) => (at < index && isChanged(line) ? at : last), -1)

  return lines.reduce((shown, line, index) => {
    if (isChanged(line)) return [...shown, line]

    const nearBefore = index - lastChangeBefore(index) <= CONTEXT_LINES
    const next = nextChangeFrom(index)
    const nearAfter = next !== -1 && next - index <= CONTEXT_LINES
    if (nearBefore || nearAfter) return [...shown, line]

    const previous = shown[shown.length - 1]
    return previous?.hidden
      ? [...shown.slice(0, -1), { hidden: previous.hidden + 1 }]
      : [...shown, { hidden: 1 }]
  }, [])
}

const diffLineHtml = (line) =>
  line.hidden
    ? html`
      <div class="diff-line is-folded">
        <span class="diff-gutter">&middot;&middot;&middot;</span>
        <span class="diff-text">${line.hidden} unchanged line${
          line.hidden === 1 ? '' : 's'
        }</span>
      </div>
    `
    : html`
      <div class="diff-line is-${line.type}">
        <span class="diff-gutter">${
          line.type === 'added' ? '+' : line.type === 'removed' ? html`&minus;` : ''
        }</span>
        <span class="diff-text">${line.text || html`&nbsp;`}</span>
      </div>
    `

const MAX_CHIPS = 4

const FIELD_LABELS = {
  status: 'Status',
  score: 'Score',
  startedDate: 'Started',
  completedDate: 'Completed',
  progress: 'Episodes watched',
  workRef: 'Linked work',
  review: 'Comments',
  'overrides.englishTranslatedTitle': 'Title',
  'overrides.originalTitle': 'Original title',
  'overrides.releaseYear': 'Release year',
  'overrides.duration': 'Duration',
  'overrides.imageUrl': 'Image',
  'overrides.genres': 'Genres',
  'overrides.directors': 'Directors',
  'overrides.actors': 'Actors',
  'overrides.authors': 'Authors',
  'overrides.publishers': 'Publishers',
  'overrides.platforms': 'Platforms',
  'overrides.studios': 'Studios',
  'overrides.episodes': 'Episodes',
}

const fieldLabel = (field) =>
  FIELD_LABELS[field] ?? prettify(field.replace('overrides.', ''))

/** `englishTranslatedTitle` -> `English translated title` */
const prettify = (field) => {
  const spaced = field.replace(/([A-Z])/g, ' $1').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const valueOf = (snapshot, field) =>
  field.startsWith('overrides.')
    ? snapshot?.overrides?.[field.replace('overrides.', '')]
    : snapshot?.[field]

/**
 * One side of a change. Everything but the "empty" marker comes back as a
 * plain string, which is the point: `fieldRowHtml` interpolates it, and a
 * plain string interpolated into an `html` template is text.
 */
const formatValue = (field, value) => {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) {
    return html`<span class="value-empty">empty</span>`
  }
  if (Array.isArray(value)) return value.join(', ')
  if (field.endsWith('Date')) return dateOnly(value)
  return String(value)
}

const historyStyle = css`
  .entry-history {
    margin-top: 45px;
    border-top: 1px solid #eee;
  }
  .history-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 4px;
    cursor: pointer;
    user-select: none;
  }
  .history-icon {
    color: #0e9ce0;
  }
  .history-title {
    font-weight: bold;
    color: #333;
  }
  .history-count {
    color: #999;
    font-size: 12px;
  }
  .history-chevron {
    margin-left: auto;
    color: #bbb;
    font-size: 12px;
    transition: transform 0.15s ease;
  }
  .history-chevron.is-open {
    transform: rotate(180deg);
  }
  .history-header:hover .history-title,
  .history-header:hover .history-chevron {
    color: #0e9ce0;
  }
  .history-empty {
    color: #888;
    font-size: 13px;
    padding: 0 4px 16px;
    max-width: 520px;
  }

  .version-list {
    list-style: none;
    margin: 0 0 10px;
    padding: 0 0 0 4px;
  }
  /* The rail every version hangs off. */
  .version {
    position: relative;
    padding-left: 22px;
  }
  .version:before {
    content: "";
    position: absolute;
    left: 4px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #e6e8ea;
  }
  .version:first-child:before {
    top: 14px;
  }
  .version:last-child:before {
    bottom: auto;
    height: 14px;
  }
  .version-dot {
    position: absolute;
    left: 0;
    top: 10px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #fff;
    border: 2px solid #ddd;
  }
  .version.is-current .version-dot {
    border-color: #0e9ce0;
    background: #0e9ce0;
  }
  .version-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    margin-left: -8px;
    border-radius: 5px;
    cursor: pointer;
  }
  .version-row:hover {
    background: #f6f8fa;
  }
  .version-when {
    font-size: 13px;
    color: #333;
    white-space: nowrap;
  }
  .version.is-current .version-when {
    font-weight: bold;
  }
  .version-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #0e9ce0;
    border: 1px solid #b8e2f6;
    background: #f2fafd;
    border-radius: 9px;
    padding: 1px 7px;
  }
  .version-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    overflow: hidden;
  }
  .version-chip {
    font-size: 11px;
    color: #555;
    background: #f0f2f4;
    border-radius: 9px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .version-chip.is-quiet {
    color: #999;
    background: transparent;
    padding-left: 0;
  }
  .version-caret {
    margin-left: auto;
    color: #ccc;
    font-size: 11px;
    transition: transform 0.15s ease;
  }
  .version-caret.is-open {
    transform: rotate(180deg);
  }
  .version-detail {
    background: #fbfcfd;
    border: 1px solid #eef0f2;
    border-radius: 6px;
    padding: 12px 14px;
    margin: 2px 0 10px;
  }
  .version-note {
    font-size: 12px;
    color: #888;
  }

  .field-changes {
    font-size: 13px;
    margin-bottom: 10px;
  }
  .field-changes td {
    padding: 2px 10px 2px 0;
    vertical-align: top;
  }
  .field-name {
    color: #888;
    font-size: 12px;
    white-space: nowrap;
  }
  .field-old {
    color: #a33;
    text-decoration: line-through;
    text-decoration-color: rgba(170, 51, 51, 0.4);
  }
  .field-arrow {
    color: #ccc;
    font-size: 10px;
  }
  .field-new {
    color: #1a7f37;
  }
  .value-empty {
    color: #bbb;
    font-style: italic;
    text-decoration: none;
  }

  .review-diff {
    margin-bottom: 12px;
  }
  .review-diff-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
  }
  .diff-added {
    color: #1a7f37;
    font-size: 12px;
    font-weight: bold;
  }
  .diff-removed {
    color: #c33;
    font-size: 12px;
    font-weight: bold;
  }
  .review-diff-body {
    border: 1px solid #e6e8ea;
    border-radius: 5px;
    overflow: auto;
    max-height: 320px;
    background: #fff;
  }
  .diff-line {
    display: flex;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.55;
  }
  .diff-gutter {
    flex: none;
    width: 26px;
    text-align: center;
    color: #b0b4b8;
    background: rgba(0, 0, 0, 0.02);
    user-select: none;
  }
  .diff-text {
    padding: 0 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .diff-line.is-added {
    background: #e6ffec;
  }
  .diff-line.is-added .diff-gutter {
    color: #1a7f37;
    background: #ccffd8;
  }
  .diff-line.is-removed {
    background: #ffebe9;
  }
  .diff-line.is-removed .diff-gutter {
    color: #c33;
    background: #ffd7d5;
  }
  .diff-line.is-folded {
    background: #f6f8fa;
    color: #999;
    font-style: italic;
  }

  .version-actions {
    display: flex;
    justify-content: flex-end;
  }
  .restore-button {
    font-size: 12px;
    color: #0e9ce0;
    background: #fff;
    border: 1px solid #b8e2f6;
    border-radius: 5px;
    padding: 4px 12px;
    cursor: pointer;
  }
  .restore-button:hover {
    background: #0e9ce0;
    border-color: #0e9ce0;
    color: #fff;
  }
`
