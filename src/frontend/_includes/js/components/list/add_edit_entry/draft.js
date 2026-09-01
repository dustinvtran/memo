/**
 * @file The autosaved draft of an entry being edited.
 *
 * A modal closed by accident, a crashed tab or a reloaded page would
 * otherwise take the whole edit with it, which for an entry with a long note
 * is the expensive kind of mistake. So while the form is open its contents
 * are autosaved, and reopening the entry offers whatever was left behind.
 *
 * A draft is never applied on its own: it is offered, and the user chooses.
 * Silently restoring it would be its own way of losing work, since the entry
 * may have been edited elsewhere since.
 */
const { html, css, waitForEl, timeAgo, dateTime } = Utils
const { el, on, onClick, fadeIn, fadeOut } = Dom
const { initComponent } = Components
const { getDraft, saveDraft, deleteDraft } = Netlify
const { readForm, writeForm } = EntryFormIO
const { deepEqual } = DeepEqual

/** Long enough not to save on every keystroke, short enough to lose little. */
const AUTOSAVE_DELAY_MS = 2500

/** How long to wait for the comments field before giving up on it. */
const COMMENTS_WAIT_MS = 5000

const DraftNotice = (type, data) => initComponent({
  content: ({ id }) => html`
    <div id="${id}" class="draft-notice-wrapper">
      <div id="${id}-banner" class="draft-notice" style="display: none;">
        <i class="fas fa-rotate-left draft-icon"></i>
        <div class="draft-text">
          <span class="draft-title">Unsaved draft</span>
          <span id="${id}-when" class="draft-when"></span>
          <span id="${id}-summary" class="draft-summary"></span>
        </div>
        <button type="button" id="${id}-restore" class="draft-restore">
          Restore
        </button>
        <button type="button" id="${id}-discard" class="draft-discard">
          Discard
        </button>
      </div>
      <div id="${id}-status" class="draft-status"></div>
    </div>
  `,
  style: () => css`
    .draft-notice {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #f2fafd;
      border: 1px solid #cfe9f7;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 13px;
    }
    .draft-icon {
      color: #0e9ce0;
    }
    .draft-text {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px;
      margin-right: auto;
    }
    .draft-title {
      font-weight: bold;
      color: #333;
    }
    .draft-when,
    .draft-summary {
      color: #777;
    }
    .draft-summary:before {
      content: "\\00b7";
      margin-right: 6px;
    }
    .draft-restore {
      background: #0e9ce0;
      border: 1px solid #0e9ce0;
      border-radius: 5px;
      color: #fff;
      font-size: 12px;
      font-weight: bold;
      padding: 4px 14px;
      cursor: pointer;
    }
    .draft-restore:hover {
      background: #0b87c4;
      border-color: #0b87c4;
    }
    .draft-discard {
      background: transparent;
      border: 0;
      color: #888;
      font-size: 12px;
      padding: 4px 6px;
      cursor: pointer;
    }
    .draft-discard:hover {
      color: #e0480e;
      text-decoration: underline;
    }
    .draft-status {
      font-size: 11px;
      color: #aaa;
      text-align: right;
      height: 15px;
    }
    @media (max-width: 560px) {
      .draft-notice {
        flex-wrap: wrap;
      }
      .draft-text {
        width: 100%;
      }
    }
  `,
  initializer: ({ id }) => {
    // The comments field arrives with a request of its own, and it is the
    // field this whole feature exists for, so the state to compare drafts
    // against is only taken once it is on the page.
    whenCommentsAreLoaded().then(() => {
      const saved = readForm(data, type)

      offerExistingDraft({ id, type, data, saved })
      autosaveWhileEditing({ id, type, data, saved })
    })
  },
})

Components.List.DraftNotice = DraftNotice

///////////////////////////////////////////////////////////////////////////////

/**
 * Resolves once the comments textarea is on the page — or after a moment
 * either way, since a failed request for the review leaves the field out
 * entirely and that must not disable autosaving the rest of the form.
 */
const whenCommentsAreLoaded = () =>
  waitForEl('#add-entry-fields textarea', { timeout: COMMENTS_WAIT_MS })

const offerExistingDraft = ({ id, type, data, saved }) => {
  getDraft(type, data.dbRef)
    .map(({ draft }) => {
      // A draft that says exactly what the entry already says has nothing to
      // offer: the last autosave simply happened after the last save.
      if (!draft || deepEqual(comparable(draft.snapshot), comparable(saved))) {
        return
      }

      // The banner carries `display: none` inline and `display: flex` in its
      // rule, so taking the inline declaration back off is what shows it —
      // which is `fadeIn`'s whole job here. The `.css('display', 'flex')`
      // that used to precede this was jQuery being told what to restore.
      //
      // It can be gone: this runs when the request for the draft answers, and
      // the modal it belongs to may have been closed by then. `$` was silent
      // about that and the three writes below are not, so it is asked once.
      const banner = el(`#${id}-banner`)
      if (!banner) return

      const when = el(`#${id}-when`)
      when.textContent = `from ${timeAgo(draft.createdDate)}`
      when.title = dateTime(draft.createdDate)
      el(`#${id}-summary`).textContent = summarise(draft.snapshot, saved)

      fadeIn(banner, 150)

      onClick(`#${id}-restore`, () => {
        writeForm(draft.snapshot, type, data)
        window.hasUnsavedChange = true
        fadeOut(banner, 150)
      })

      onClick(`#${id}-discard`, () => {
        deleteDraft(type, data.dbRef)
        fadeOut(banner, 150)
      })
    })
    // A network blip must not stop anyone from editing, so this stays quiet.
    .mapErr(() => undefined)
}

/** Enough of what the draft would change to decide whether to want it back. */
const summarise = (draft, saved) => {
  const fields = Object.keys({ ...comparable(draft), ...comparable(saved) })
    .filter((field) => field !== 'review')
    .filter((field) => !deepEqual(comparable(draft)[field], comparable(saved)[field]))

  const noteChanged = (draft.review ?? '') !== (saved.review ?? '')
  const parts = [
    noteChanged ? 'the comments' : '',
    fields.length === 1 ? '1 other field' : fields.length > 1 ? `${fields.length} other fields` : '',
  ].filter((part) => part)

  return parts.length === 0 ? 'changes to this entry' : `${parts.join(' and ')} differ`
}

const autosaveWhileEditing = ({ id, type, data, saved }) => {
  let timer

  const save = () => {
    // The modal is gone: this is a timer that outlived the form it belonged
    // to, and the entry may since have been saved for real. `isConnected`
    // rather than a walk up to <body>, which is what `.closest('body')` was.
    if (!el(`#${id}`)?.isConnected) return

    const current = readForm(data, type)
    if (deepEqual(comparable(current), comparable(saved))) return

    const status = el(`#${id}-status`)
    saveDraft(type, data.dbRef, current)
      .map(() => {
        if (status) status.textContent = `Draft saved ${clockTime(Date.now())}`
      })
      .mapErr(() => {
        if (status) status.textContent = 'Could not save a draft of these changes.'
      })
  }

  // One listener on the form for both events rather than one per field: the
  // comments textarea arrives with a request of its own, and `input` and
  // `change` both bubble, so the form hears about a field that was not there
  // when this ran. jQuery's delegation did the same and was spelled shorter.
  const fields = el('#add-entry-fields')
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(save, AUTOSAVE_DELAY_MS)
  }
  on(fields, 'input', schedule)
  on(fields, 'change', schedule)
}

/** The form sends fields the draft doesn't carry (and vice versa) as absent
 * rather than null depending on the type, which is not a difference worth
 * offering to restore. */
const comparable = (snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot ?? {})
      .filter(([_field, value]) => value !== null && value !== undefined)
      .map(([field, value]) => [
        field,
        field === 'overrides' ? comparable(value) : value,
      ])
  )

const clockTime = (timestamp) =>
  new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
