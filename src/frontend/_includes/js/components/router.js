const { initComponent, Error404 } = Components
const { HomePage } = Components.Home
const { ProfilePage } = Components.Profile
const { ListPage } = Components.List

const { isType } = Conversions

const segments = window.location.pathname?.split?.('/')?.filter(s => s)

const Router =
  segments.length === 0     ? HomePage :
  segments[0] === 'profile' ? ProfilePage :
  isType(segments[0])       ? ListPage :
  Error404

Components.Router = Router
