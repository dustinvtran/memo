const { html, css } = Utils
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

      $('#status').on('change', () => {
        if ($('#status').val() === 'Planned') {
          $('#progress-container').show()
          $('label[for="score"]').html('Preference')
          ;['started-date', 'completed-date'].forEach((field) => {
            $(`#${field}`).val('')
            $(`#${field}-container`).hide()
          })
          $('#progress-container').show()
        } else if ($('#status').val() === 'Dropped') {
          $('label[for="score"]').html('Score')
          $('#progress-container').show()
          $('#started-date-container').show()
          $('#completed-date').val('')
          $('#completed-date-container').hide()
        } else if ($('#status').val() === 'Completed') {
          $('label[for="score"]').html('Score')
          $('#started-date-container').show()
          $('#completed-date-container').show()
          $('#completed-date').val(today())
          $('#progress-container').hide()
          $('#progress-container').val($('#episodes').html())
        } else if ($('#status').val() === 'InProgress') {
          $('label[for="score"]').html('Score')
          $('#started-date-container').show()
          $('#completed-date').val('')
          $('#started-date').val(data.startedDate ? timestampToString(data.startedDate) : today())
          $('#completed-date-container').hide()
          $('#progress-container').show()
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


const today = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth()+1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}


const timestampToString = (ts) =>
  (new Date(ts)).toISOString().substring(0, 10)
