const { entryTypes, getEntries } = Netlify
const { profileColumns } = Tables
const { initTable } = TableView
const { typeToTitle } = Conversions
const { html, css } = Utils
const { UsernameSetter } = Components.Profile
const { initComponent, WithRemoteData } = Components

const ProfileLists = (username) => initComponent({
  content: ({ include }) => html`
    <h2>Recent updates</h2>
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between;">
      ${include(entryTypes.map((type) => ProfileList(username, type)))}
    </div>
    <hr>
  `
})


Components.Profile.ProfileLists = ProfileLists

///////////////////////////////////////////////////////////////////////////////

const ProfileList = (username, type) => initComponent({
  content: ({ include }) => html`
    <div class="profile-list">
      <h3><a href="/${type}/${encodeURIComponent(username)}">${typeToTitle[type]}</a></h3>
      ${include(WithRemoteData({
        remoteData: getEntries(type, username, 5),
        component: (entries) => ProfileTable(type, entries)
      }))}
    </div>
  `,
  style: () => css`
    .profile-list {
      width: 48%;
    }

    .profile-list .entry-table {
      font-size: 12px;
    }

    @media (max-width: 600px) {
      .profile-list {
        width: 100%;
      }
    }
  `
})

const ProfileTable = (type, data) => initComponent({
  content: () => html`
    <div id="summary-${type}"></div>
  `,
  initializer: () => {
    initProfileTable(typeToCssId(type), data)
  }
})

/**
 * No header, no search and no Columns button: this is five recent entries as a
 * teaser for the list page, and the only thing it shares with a full list is
 * the cell formatters.
 *
 * The five are the API's — `getEntries(type, username, 5)` above asks for that
 * many. bootstrap-table was also passed `pageSize: 5` and
 * `onlyInfoPagination: true`, and neither did anything: both belong to its
 * pagination, which was off, so the summary line they describe has never been
 * drawn on this page. They are gone rather than reimplemented.
 *
 * Hiding the header is what takes the sort away too, since a header is the only
 * thing a reader can click to ask for one.
 */
const initProfileTable = (selector, data) => initTable(selector, data, {
  showHeader: false,
  columns: profileColumns(),
})

const typeToCssId = (type) => `#summary-${type}`
