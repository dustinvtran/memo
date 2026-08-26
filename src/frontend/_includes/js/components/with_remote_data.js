const { initComponent, setContent, Div } = Components
const { html, css, escapeHtml } = Utils
const { identity } = R
const { errorMessage } = Http

const WithRemoteData = ({ remoteData, component }) => initComponent({
  content: ({ id, include }) => html`
    <div id="${id}">${include(Loader())}</div>
  `,
  initializer: ({ id }) => {
    const showComponent = (data) => setContent(`#${id}`, component(data))
    const showError = (err) =>
      setContent(`#${id}`, Div(`Error: ${escapeHtml(errorMessage(err))}`))

    if (remoteData instanceof NT.ResultAsync) {
      remoteData.map(showComponent).mapErr(showError)
    } else {
      remoteData.then(showComponent).catch(showError)
    }
  }
})

Components.WithRemoteData = WithRemoteData

///////////////////////////////////////////////////////////////////////////////

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
      background: #ddd;
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
