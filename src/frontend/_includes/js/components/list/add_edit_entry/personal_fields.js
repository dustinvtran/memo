const { html, css } = Utils
const { el, on, show, hide } = Dom
const { initComponent, WithRemoteData } = Components
const { statuses, filmStatuses } = Tables
const { statusToTitle } = Conversions
const { initialReviewText } = ReviewTemplate

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
            value=${
              data.completedDate
                ? timestampToString(data.completedDate)
                : type === 'films'
                ? today()
                : ''
            }
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
      if (document.getElementById('started-date')) {
        new Litepicker({ element: document.getElementById('started-date') })
      }
      if (document.getElementById('completed-date')) {
        new Litepicker({ element: document.getElementById('completed-date') })
      }

      const status = el('#status')

      on(status, 'change', () => {
        // A `select` whose value matches no option reads back as the empty
        // string, which matches none of the branches below — the same nothing
        // jQuery's `.val()` gave.
        if (status.value === 'Planned') {
          show('#progress-container')
          setScoreLabel('Preference')
          ;['started-date', 'completed-date'].forEach((field) => {
            setField(field, '')
            hide(`#${field}-container`)
          })
          show('#progress-container')
        } else if (status.value === 'Dropped') {
          setScoreLabel('Score')
          show('#progress-container')
          show('#started-date-container')
          setField('completed-date', '')
          hide('#completed-date-container')
        } else if (status.value === 'Completed') {
          setScoreLabel('Score')
          show('#started-date-container')
          show('#completed-date-container')
          setField('completed-date', today())
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
          setField('completed-date', '')
          setField(
            'started-date',
            data.startedDate ? timestampToString(data.startedDate) : today()
          )
          hide('#completed-date-container')
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
 * The label over the score dropdown, which reads "Preference" for something
 * nobody has got to yet. `textContent`, not `innerHTML`: it is a word.
 */
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
