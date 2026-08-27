const { entryTypes, getEntries } = Netlify
const { col, initTable, profileColumns } = Tables
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

    .profile-list .bootstrap-table {
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
    <table id="summary-${type}"></table>
  `,
  initializer: () => {
    initProfileTable(typeToCssId(type), data)
  }
})

const initProfileTable = (selector, data) => initTable(selector, data, {
  iconsPrefix: 'fa',
  pageSize: 5,
  onlyInfoPagination: true,
  showHeader: false,
  columns: profileColumns(),
})

const typeToCssId = (type) => `#summary-${type}`
