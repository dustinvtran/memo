const { initComponent, WithRemoteData, Error404, NotFoundOrFailure } = Components
const { Base } = Components.UI
const { getUserFromName } = Netlify
const { ProfileLists, ProfileStats, Biography } = Components.Profile
const { getNameFromUrl } = Http

const ProfilePage = () => initComponent({
  content: ({ include }) => include(
    WithRemoteData({
      remoteData: getUserFromName(getNameFromUrl()),
      component: ({ data }) => data
      ? Base(`${getNameFromUrl()}'s profile`, [
        Biography(data),
        ProfileLists(getNameFromUrl()),
        ProfileStats(getNameFromUrl()),
      ])
        : Error404(),
      errorComponent: NotFoundOrFailure,
    })
  ),
  initializer: () => {
    const user = getNameFromUrl()
    document.title = user
      ? `${user}'s profile | Memo`
      : `Not found`
  }
})

Components.Profile.ProfilePage = ProfilePage
