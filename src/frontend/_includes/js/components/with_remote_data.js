const { initComponent, setContent, Div } = Components
const { html, css } = Utils
const { errorMessage } = Http

/**
 * `errorComponent` draws whatever the request failed with — `{ status, error,
 * message }`, which is what `Http` hands on. The default shows the line the
 * API wrote for whoever asked, and that is as much as this component can know.
 * A caller that knows what its own failures mean passes something better: a
 * 401 on a page only a logged-in user reaches is a session that has ended, and
 * the answer to that is to log in again rather than to try again. See #216.
 */
const WithRemoteData = ({ remoteData, component, errorComponent = RemoteFailure }) => initComponent({
  content: ({ id, include }) => html`
    <div id="${id}">${include(Loader())}</div>
  `,
  initializer: ({ id }) => {
    const showComponent = (data) => setContent(`#${id}`, component(data))
    const showError = (err) => setContent(`#${id}`, errorComponent(err))

    if (remoteData instanceof NT.ResultAsync) {
      remoteData.map(showComponent).mapErr(showError)
    } else {
      remoteData.then(showComponent).catch(showError)
    }
  }
})

Components.WithRemoteData = WithRemoteData

///////////////////////////////////////////////////////////////////////////////

/** What a failed request draws unless the caller has something better. */
const RemoteFailure = (err) => Div(`Error: ${errorMessage(err)}`)

/* Published as well as defaulted to, so that a caller with one failure of its
   own to handle has somewhere to send all the rest. Below the definition
   rather than beside `WithRemoteData`: this line runs while the file is being
   read, and the `const` above is not initialised until it does. */
Components.RemoteFailure = RemoteFailure

/**
 * For a page whose first request is "does this exist": a 404 is the page not
 * being there, which is `Error404`, and anything else is a request that
 * failed. The list and the profile pages ask `/api/name/:name` and
 * `/api/user/:name`, which answer 404 for a name nobody has taken since #477
 * rather than a `200 {}` for the page to look inside.
 *
 * `Components.Error404` read when a failure is drawn rather than destructured
 * at the top: that would tie this file's place in the bundle to common.js's
 * for the sake of one lookup.
 */
const NotFoundOrFailure = (err) => err?.status === 404
  ? Components.Error404()
  : RemoteFailure(err)

Components.NotFoundOrFailure = NotFoundOrFailure

const Loader = () => initComponent({
  content: () => html`
    <div class="loader-wrapper">
      <div class="lds-ellipsis"><div></div><div></div><div></div><div></div></div>
    </div>
  `,
  style: () => css`
    .loader-wrapper {
      width: 100%;
      text-align: center;
    }
    .lds-ellipsis {
      display: inline-block;
      position: relative;
      width: 80px;
      height: 80px;
    }
    .lds-ellipsis div {
      position: absolute;
      top: 33px;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: var(--border);
      animation-timing-function: cubic-bezier(0, 1, 1, 0);
    }
    .lds-ellipsis div:nth-child(1) {
      left: 8px;
      animation: lds-ellipsis1 0.6s infinite;
    }
    .lds-ellipsis div:nth-child(2) {
      left: 8px;
      animation: lds-ellipsis2 0.6s infinite;
    }
    .lds-ellipsis div:nth-child(3) {
      left: 32px;
      animation: lds-ellipsis2 0.6s infinite;
    }
    .lds-ellipsis div:nth-child(4) {
      left: 56px;
      animation: lds-ellipsis3 0.6s infinite;
    }
    @keyframes lds-ellipsis1 {
      0% {
        transform: scale(0);
      }
      100% {
        transform: scale(1);
      }
    }
    @keyframes lds-ellipsis3 {
      0% {
        transform: scale(1);
      }
      100% {
        transform: scale(0);
      }
    }
    @keyframes lds-ellipsis2 {
      0% {
        transform: translate(0, 0);
      }
      100% {
        transform: translate(24px, 0);
      }
    }
  `
})
