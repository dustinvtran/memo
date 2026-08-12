const { initComponent, Error404, WithRemoteData } = Components
const { getUserIdFromName, getUserName, getEntries } = Netlify
const { getNameFromUrl, getEntryTypeFromUrl } = Http
const { List } = Components.List
const { typeToTitle } = Conversions

const ListPage = () => initComponent({
  content: ({ include }) => {
    const entryType = getEntryTypeFromUrl()
    const username = getNameFromUrl()

    if (!typeToTitle[entryType]) return include(Error404())

    // All three requests go out together, before any of them has answered.
    // Asked for in the order the page needs them — does this user exist, then
    // the list, then may this visitor edit it — they cost three round trips
    // end to end, and the entries, by far the slowest and the only one the
    // page has to wait for, would be the last to be sent.
    const user = getUserIdFromName(username)
    const entries = getEntries(entryType, username)
    // Resolved once and shared: every table on the page asks whose list this
    // is, and each of them used to ask the server again.
    const isOwner = getUserName()
      .map((resp) => resp?.username === username)
      .unwrapOr(false)

    return include(WithRemoteData({
      remoteData: user,
      component: ({ data }) => data
        ? List({ username, entryType, entries, isOwner })
        : Error404()
    }))
  },
  initializer: () => {
    const typeTitle = typeToTitle[getEntryTypeFromUrl()]
    const user = getNameFromUrl()
    document.title = typeTitle && user
      ? `${user}'s ${typeTitle.toLowerCase()} | Memo`
      : `Not found`

    const urlAnchor = window.location.hash.substring(1)

    // Wait for the anchor element to actually be rendered, then unfold
    // the review and jump to the element
    if (urlAnchor) {
      const observer = new MutationObserver((mutations, obs) => {
        const element = document.getElementById(urlAnchor)
        if (element) {
          $(`#${urlAnchor}`).parent().prev().find('i').trigger('click')

          // jump to the element, hacky as fuck
          location.hash = '#__nothing'
          location.hash = '#' + urlAnchor
          obs.disconnect()
          return
        }
      })

      observer.observe(document, {
        childList: true,
        subtree: true
      })
    }
  }
})

Components.List.ListPage = ListPage
