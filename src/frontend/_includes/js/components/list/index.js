const { initComponent, Error404, WithRemoteData } = Components
const { getUserIdFromName, getUserName, getEntries } = Netlify
const { getNameFromUrl, getEntryTypeFromUrl } = Http
const { waitForEl } = Utils
const { List } = Components.List
const { isType, byType } = Conversions

const ListPage = () => initComponent({
  content: ({ include }) => {
    const entryType = getEntryTypeFromUrl()
    const username = getNameFromUrl()

    if (!isType(entryType)) return include(Error404())

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
    const typeTitle = byType(getEntryTypeFromUrl())?.title
    const user = getNameFromUrl()
    document.title = typeTitle && user
      ? `${user}'s ${typeTitle.toLowerCase()} | Memo`
      : `Not found`

    const urlAnchor = window.location.hash.substring(1)

    // Wait for the anchor element to actually be rendered, then unfold
    // the review and jump to the element. The fragment is whatever was in the
    // url, so it may well name a row that is not on this page — a deleted
    // entry, a link to somebody else's list, a typo — and the wait has to end
    // either way rather than watch the document for a row that is not coming.
    //
    // `CSS.escape` because that same fragment goes into a selector here: an
    // id is free to contain characters that mean something to a selector
    // parser, and an unescaped one throws instead of matching nothing.
    if (urlAnchor) {
      waitForEl(`#${CSS.escape(urlAnchor)}`).then((element) => {
        if (!element) return

        // The row's caret, found from the row rather than by counting cells
        // across from the title — the caret is not always the previous one, and
        // a column toggle moves the rest. A real click, so it goes through the
        // same handler in `utils/table_view.js` as a reader's would.
        element.closest('tr')?.querySelector('a.detail-icon')?.click()

        // jump to the element, hacky as fuck
        location.hash = '#__nothing'
        location.hash = '#' + urlAnchor
      })
    }
  }
})

Components.List.ListPage = ListPage
