/**
 * @file Linking an entry that has no work to one in the database.
 *
 * An entry added for something the databases do not carry yet — a film out
 * next month, a game released last week — stores its title, year and genres in
 * its own `overrides` and points at no work at all. 23 entries in production
 * are that, deliberately. A month later the database does have it, and until
 * now the only way to attach the two was to delete the entry and retype every
 * field onto a new one, losing the dates, the score and the note in the
 * process. #343.
 *
 * **The link is a question, not a merge.** Both sides have a title, a year and
 * a set of genres, and which is better is not something this can work out: the
 * typed one may be a season's name, a DLC's, an edition the database does not
 * carry, or it may be the guess that is being replaced. So every field the two
 * disagree on is listed with both values and a choice, defaulting to the
 * database's — that is what linking is for — and nothing is hidden behind the
 * default. `overrides` is where a kept value goes, which is the same place a
 * season name has always lived.
 *
 * **Nothing is saved here.** Choosing fills the form in, exactly as
 * `history.js` does when it puts a past version back, and the person still
 * presses Edit entry. A link that saved itself would be a write nobody asked
 * for on a form they might close.
 */
const { html, css } = Utils
const { el } = Dom
const { initComponent, setContent } = Components
const { InputWithAction, Button, showNotification } = Components.UI
const { searchWorks, retrieveWork } = Netlify
const { typeToTitle } = Conversions
const { differencesFrom, takeFromWork } = EntryFormIO
const { errorMessage } = Http
const { icon } = Icons

/**
 * `data` is the row being edited, and it is **mutated** when a work is chosen:
 * `commonMetadata` is what `readForm` reads the `workRef` out of and
 * `originalData` is the baseline it works the overrides out against. The
 * alternative is redrawing the whole form around a new object, which throws
 * away the note and the history — both of which arrive in requests of their
 * own and would have to be fetched again.
 */
const LinkToWork = (type, data) => initComponent({
  content: ({ id, include }) => html`
    <div id="${id}" class="link-to-work">
      <div class="link-to-work-notice">
        ${icon('link')}
        <span>
          This entry is not in the database, so nothing about it refreshes —
          its title, year and cover are whatever was typed.
        </span>
      </div>
      <div id="${id}-open">
        ${include(Button({
          label: `Find it in the database`,
          onClick: () => setContent(`#${id}-panel`, SearchPanel(type, data, id)),
        }))}
      </div>
      <div id="${id}-panel"></div>
    </div>
  `,
  style: () => css`
    .link-to-work {
      border: 1px solid #f0c060;
      background: #fffaf0;
      border-radius: 7px;
      padding: 12px 15px;
      margin: 0 0 15px;
    }
    .link-to-work-notice {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 13px;
    }
    .link-to-work-linked {
      color: #0e9ce0;
      font-weight: bold;
      font-size: 13px;
    }
    .link-to-work-choice {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px;
      padding: 5px 0;
      border-top: 1px solid #f0e0c0;
      font-size: 13px;
    }
    .link-to-work-label {
      font-weight: bold;
      min-width: 110px;
    }
    .link-to-work-value {
      max-width: 340px;
      overflow-wrap: anywhere;
    }
    .link-to-work-mine {
      color: #e0480e;
    }
    .link-to-work-who {
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 0.06em;
      color: #888;
      margin-right: 3px;
    }
    .link-to-work-choice label {
      cursor: pointer;
      margin-right: 12px;
    }
  `,
})

Components.List.LinkToWork = LinkToWork

///////////////////////////////////////////////////////////////////////////////

/**
 * The search, and the results, and then the comparison — in one panel that
 * replaces its own contents at each step, so that the form behind it never
 * moves.
 */
const SearchPanel = (type, data, parentId) => initComponent({
  content: ({ include }) => html`
    <div id="${parentId}-search">
      ${include(InputWithAction({
        label: `Search ${typeToTitle[type]}`,
        btnLabel: "Search",
        onSubmit: (query) => {
          searchWorks(type, query)
            .map((results) =>
              setContent(`#${parentId}-results`, Results(type, data, parentId, results))
            )
            .mapErr((err) => showNotification(errorMessage(err)))
        },
      }))}
    </div>
    <div id="${parentId}-results"></div>
  `,
})

/**
 * The results, reusing the add flow's own list rather than a second copy of
 * it. `SearchResults` is read here rather than destructured at the top of the
 * file, because this file is bundled *above* the one that defines it — it has
 * to be, since `entry_form.js` destructures `LinkToWork` when it loads. By the
 * time anything below runs, every file in the bundle has.
 */
const Results = (type, data, parentId, results) =>
  Components.List.SearchResults(type, results, ({ ref }) => {
    retrieveWork(type, ref)
      .map((work) =>
        setContent(`#${parentId}-results`, Comparison(type, data, parentId, work))
      )
      .mapErr((err) => showNotification(errorMessage(err)))
  })

/**
 * Both values for every field the two disagree on, and a choice for each.
 *
 * The radios default to the database, because a person who has just picked a
 * work out of a list is saying they want what it knows. What keeps that from
 * being a silent overwrite is that every one of them is on screen with the
 * typed value beside it: the default is visible, and changing it is one click.
 */
const Comparison = (type, data, parentId, work) => {
  const differences = differencesFrom(work, type)

  return initComponent({
    content: ({ id }) => html`
      <div id="${id}">
        <p class="link-to-work-linked">
          ${work.englishTranslatedTitle}${work.releaseYear ? ` (${work.releaseYear})` : ''}
        </p>
        ${differences.length === 0
          ? html`<p>Everything you typed already matches. Linking changes nothing else.</p>`
          : html`
            <p>
              These disagree. Anything you keep is stored as an override on this
              entry, which is how a season or a DLC keeps its own name.
            </p>
            ${differences.map(({ id: fieldId, label, mine, theirs }) => html`
              <div class="link-to-work-choice">
                <span class="link-to-work-label">${label}</span>
                <label>
                  <input type="radio" name="${id}-${fieldId}" value="theirs" checked>
                  <span class="link-to-work-who">database</span>
                  <span class="link-to-work-value">${theirs || '(empty)'}</span>
                </label>
                <label>
                  <input type="radio" name="${id}-${fieldId}" value="mine">
                  <span class="link-to-work-who">yours</span>
                  <span class="link-to-work-value link-to-work-mine">${mine || '(empty)'}</span>
                </label>
              </div>
            `)}
          `}
        <div id="${id}-confirm" style="margin-top: 10px"></div>
      </div>
    `,
    initializer: ({ id }) => {
      setContent(`#${id}-confirm`, Button({
        label: "Link this entry",
        onClick: () => {
          // Only the fields whose radio still says "theirs". The rest keep what
          // is in them, and `getOverrides` turns that into an override when the
          // form is read — nothing here writes one.
          takeFromWork(
            work,
            type,
            differences
              .filter(({ id: fieldId }) => chosen(`${id}-${fieldId}`) !== 'mine')
              .map(({ id: fieldId }) => fieldId)
          )

          // The row the submit button reads when it is pressed. `commonMetadata`
          // carries the `workRef`; `originalData` is the baseline the overrides
          // are worked out against, and has to be the work as the API gave it
          // rather than the form's idea of it.
          data.commonMetadata = work
          data.originalData = work
          window.hasUnsavedChange = true

          // The whole box, notice included: leaving "this entry is not in the
          // database" above "linked to The Odyssey" is it contradicting itself.
          setContent(`#${parentId}`, Linked(work))
          refreshOverrideHints(type, data)
        },
      }))
    },
  })
}

/** What the box says once a work has been chosen and nothing saved yet. */
const Linked = (work) => initComponent({
  content: () => html`
    <div class="link-to-work-notice">
      ${icon('link')}
      <span class="link-to-work-linked">
        Linked to ${work.englishTranslatedTitle}${work.releaseYear ? ` (${work.releaseYear})` : ''}.
        Press Edit entry to save it.
      </span>
    </div>
  `,
})


/**
 * Redraws the metadata column so its "You have overriden this field" hints
 * describe the work that was just chosen rather than the nothing there was
 * before. Only that column: the dates, the score and the note are elsewhere on
 * the form and are not what changed.
 */
const refreshOverrideHints = (type, data) => {
  const slot = el('#external-fields-slot')
  if (!slot) return
  setContent(slot, Components.List.ExternalFields(
    { commonMetadata: data.commonMetadata, overrides: readOverrides(type, data) },
    type
  ))
}

/** What the form would store as overrides if it were saved as it stands. */
const readOverrides = (type, data) => EntryFormIO.readForm(data, type).overrides

/** Which radio of a group is selected, or `undefined` if none is. */
const chosen = (name) =>
  el(`input[name="${name}"]:checked`)?.value
