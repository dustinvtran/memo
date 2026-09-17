const { html, css } = Utils
const { el, on, show, hide } = Dom
const { initComponent, WithRemoteData } = Components
const { statuses, filmStatuses } = Tables
const { statusToTitle } = Conversions
const { initialReviewText } = ReviewTemplate
const { loadLitepicker } = LoadScript

const PersonalFields = (data, type) => {
  const isEdit = data?.status ?? false
  return initComponent({
    content: ({ include }) => html`
      <div id="personal-fields">
        <div style="margin: 15px 0">
          <label for="status">Status</label><br>
          <select name="status" id="status">
            ${
              (type === 'films' ? filmStatuses : statuses)
                .map((status) => html`
                  <option value="${status}" ${status == data.status ? 'selected' : ''}>
                    ${statusToTitle(type, status)}
                  </option>
                `)
            }
          </select>
        </div>
        <div style="margin: 15px 0">
          <label for="score">${data.status === 'Planned' ? 'Preference' : 'Score'}</label><br>
          <select name="score" id="score">
            ${
              ['Unrated', '10','9','8','7','6','5','4','3','2','1']
                .map((num) => html`
                  <option value="${num}" ${num == data.score ? 'selected' : ''}>
                    ${num}
                  </option>
                `)
            }
          </select>
        </div>
        ${type === 'tv'
          ? html`
            <div
              id="progress-container"
              style="margin: 15px 0; display: ${data.status !== 'Completed' ? 'block' : 'none'};}"
            >
              <label for="progress">Episodes watched</label><br>
              <input
                id="progress"
                type="number"
                value="${data.progress ?? ''}"
              >
            </div>
          `
          : ''
        }
        ${type !== 'films'
          ? html`
            <div
              id="started-date-container"
              style="margin: 15px 0; display: ${data.status !== 'Planned' ? 'block' : 'none'};"
            >
              <label for="started-date">Started Date</label><br>
              <input
                data-toggle="datepicker"
                id="started-date"
                autocomplete="off"
                value="${
                  data.startedDate
                    ? timestampToString(data.startedDate)
                    : data.status === 'Planned'
                    ? null
                    : today()
                }"
              >
            </div>
          `
          : ''
        }
        <div
          id="completed-date-container"
          style="
            margin: 15px 0;
            display: ${
              data.status === 'Completed' ||
              (type === 'films' && data.status !== 'Planned')
                ? 'block'
                : 'none'
            };
          "
        >
          <label for="completed-date">Completed Date</label><br>
          <input
            data-toggle="datepicker"
            id="completed-date"
            autocomplete="off"
            value=${completedDateValue(data, type)}
          >
        </div>
        ${include(
          isEdit
            ? WithRemoteData({
                remoteData: Netlify.getReview(type, data.dbRef),
                component: (review) => CommentsField(type, review),
              })
            : CommentsField(type)
          )}
      </div>
    `,
    initializer: () => {
      // Not awaited, and it cannot be: this initializer is called by the
      // component system, which does nothing with what it returns, and the
      // rest of the form below must not wait on a CDN. `attachDatePickers`
      // reports its own failures for the same reason.
      attachDatePickers(['started-date', 'completed-date'])

      const status = el('#status')

      on(status, 'change', () => {
        // A `select` whose value matches no option reads back as the empty
        // string, which matches none of the branches below — the same nothing
        // jQuery's `.val()` gave.
        if (status.value === 'Planned') {
          show('#progress-container')
          setScoreLabel('Preference')
          ;['started-date', 'completed-date'].forEach((field) => {
            hideIfEmpty(`#${field}-container`, field)
          })
          show('#progress-container')
        } else if (status.value === 'Dropped') {
          setScoreLabel('Score')
          show('#progress-container')
          show('#started-date-container')
          hideIfEmpty('#completed-date-container', 'completed-date')
        } else if (status.value === 'Completed') {
          setScoreLabel('Score')
          show('#started-date-container')
          show('#completed-date-container')
          // Only when there is nothing there. Filling an empty field is a
          // convenience; writing over a date someone typed is the same silent
          // edit this handler used to make everywhere else.
          if (!fieldValue('completed-date')) setField('completed-date', today())
          hide('#progress-container')
          // A `.val()` on `#progress-container`, given the `.html()` of
          // `#episodes`, used to follow — and it did nothing twice over.
          // `#progress-container` is a <div>, so setting a value set a
          // property nothing reads back, and `#episodes` is an <input>, whose
          // inner HTML is the empty string. What it presumably wanted, filling
          // the episode count in when an entry is completed, is a feature
          // rather than a translation, so it is not written back here.
        } else if (status.value === 'InProgress') {
          setScoreLabel('Score')
          show('#started-date-container')
          if (!fieldValue('started-date')) {
            setField(
              'started-date',
              data.startedDate ? timestampToString(data.startedDate) : today()
            )
          }
          hideIfEmpty('#completed-date-container', 'completed-date')
          show('#progress-container')
        }
      })
    }
  })
}

Components.List.PersonalFields = PersonalFields

///////////////////////////////////////////////////////////////////////////////

const CommentsField = (type, review) => initComponent({
  content: () => html`
    <div style="margin: 15px 0">
      <label for="review">Comments</label><br>
      <textarea id="review" name="review" rows="19" cols="50">${initialReviewText(type, review?.data?.text)}</textarea>
    </div>
  `
})


/**
 * Turns the named text inputs into date pickers, once litepicker is there to
 * do it with.
 *
 * Litepicker is fetched on demand — see `utils/load_script.js` for why 64 KB
 * for two fields is no longer in `base.njk` — so this is asynchronous where it
 * used to be two constructor calls. Both fields ask in the same tick and
 * `loadLitepicker` hands them the same load, so that is one request and one
 * <script> however many times the form is opened.
 *
 * The elements are looked up *before* the await rather than after, which is
 * what keeps a form closed and reopened while the load is in flight from
 * ending up with two pickers on one input: the first call is holding the
 * inputs of the form that is gone, and `isConnected` is false for them. The
 * same check is what stops a picker being attached to a form the reader has
 * already closed.
 *
 * A failure leaves the two inputs as what they already are: text boxes taking
 * a `YYYY-MM-DD` string, which is what the form reads back out of them either
 * way. That is the whole reason this catches rather than rejecting — an
 * initializer that throws takes the status dropdown's handler with it, and the
 * fields it shows and hides are the rest of this form.
 */
const attachDatePickers = async (ids) => {
  const elements = ids.map((id) => document.getElementById(id)).filter(Boolean)
  if (elements.length === 0) return

  try {
    const Litepicker = await loadLitepicker()
    elements
      .filter((element) => element.isConnected)
      .forEach((element) => new Litepicker({ element }))
  } catch (error) {
    console.error(`the date fields are plain text fields: ${error.message}`)
  }
}


/**
 * The label over the score dropdown, which reads "Preference" for something
 * nobody has got to yet. `textContent`, not `innerHTML`: it is a word.
 */
/** What is typed in a field right now, as opposed to what `data` was built with. */
const fieldValue = (id) => el(`#${id}`)?.value ?? ''

/**
 * Hides a field this status has no use for — unless something is in it.
 *
 * This handler used to empty the field and hide it, which is a silent edit: a
 * date someone typed disappeared on a status change, the save went through, and
 * nothing said so. The rule is now enforced on the server (`entry_state.js`),
 * which refuses the save and says why — so the field has to stay visible and
 * filled for that message to have anything to point at, and for the person to
 * be the one who clears it.
 *
 * @type {(container: string, field: string) => void}
 */
const hideIfEmpty = (container, field) => {
  if (fieldValue(field)) show(container)
  else hide(container)
}

const setScoreLabel = (text) => {
  const label = el('label[for="score"]')
  if (label) label.textContent = text
}

/** A form field this entry type may not have at all. */
const setField = (id, value) => {
  const field = document.getElementById(id)
  if (field) field.value = value
}


const today = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth()+1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}


const timestampToString = (ts) =>
  (new Date(ts)).toISOString().substring(0, 10)

/**
 * What the completed date field starts with.
 *
 * A film is usually watched the day it is added, so the field is prefilled
 * with today — **except on a Planned one**, which has not been watched at all.
 * The container for a Planned film is hidden, so the date was invisible and
 * the form submitted it anyway: `readForm` reads the field's value, not
 * whether anybody can see it.
 *
 * That put a completed date on watchlist films for years, and once #359 began
 * refusing the state it stopped being bad data and became a wall — a Planned
 * film could not be saved at all, and the field to clear was not on screen.
 *
 * A new entry has no status yet and still gets today, which is the case the
 * default was written for.
 * @type {(data: any, type: string) => string}
 */
const completedDateValue = (data, type) =>
  data?.completedDate
    ? timestampToString(data.completedDate)
    : type === 'films' && data?.status !== 'Planned'
    ? today()
    : ''

// Down here rather than beside PersonalFields above: it is a `const`, and
// the assignment up there would run before this file reaches the declaration.
Components.List.completedDateValue = completedDateValue
