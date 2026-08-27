/**
 * @file Netlify API calls and utility
 */

// API CALLS

const getUserName = () => Http.get(ENDPOINTS.name)

const getUserIdFromName = (name) => Http.get(ENDPOINTS.idFromName(name))

const getUserFromName = (name) => Http.get(ENDPOINTS.user(name))

const getEntries = (type, username, limit) => Http.get(ENDPOINTS.entries(type, username, limit))

const getReview = (type, entryId) => Http.get(ENDPOINTS.retrieveReview(type, entryId))

const getStats = (username) => Http.get(ENDPOINTS.stats(username))

const setName = (newName) => Http.post(ENDPOINTS.name, { newName })

const setBio = (newBio) => Http.post(ENDPOINTS.bio, { newBio })

const searchWorks = (type, query) => Http.get(
  ENDPOINTS.searchWorks(type, encodeURIComponent(query))
)

const retrieveWork = (type, ref) => Http.get(
  ENDPOINTS.retrieveWork(type, ref)
)

const createEntry = (type, entry) => Http.post(
  ENDPOINTS.createEntry(type),
  entry
)

const updateEntry = (type, ref, entry) => Http.patch(
  ENDPOINTS.updateEntry(type, ref),
  entry
)

const deleteEntry = (type, ref) => Http.del(
  ENDPOINTS.deleteEntry(type, ref)
)

const getVersions = (type, ref) => Http.get(ENDPOINTS.versions(type, ref))

const getDraft = (type, ref) => Http.get(ENDPOINTS.draft(type, ref))

const saveDraft = (type, ref, snapshot) => Http.put(
  ENDPOINTS.draft(type, ref),
  snapshot
)

const deleteDraft = (type, ref) => Http.del(ENDPOINTS.draft(type, ref))


// UTILITY

/**
 * The types a profile page stacks lists and stats for, in the order it stacks
 * them. Kept here under its old name for the two components that destructure
 * it off `Netlify`; the order and the membership are `utils/conversions.js`'s
 * to decide. See #221.
 */
const entryTypes = Conversions.TYPES

const getToken = Http.getToken

const isLoggedIn = () => getToken() != null

Netlify = {
  getToken,
  getUserName,
  getEntries,
  getUserIdFromName,
  getUserFromName,
  searchWorks,
  retrieveWork,
  setName,
  entryTypes,
  isLoggedIn,
  createEntry,
  getReview,
  updateEntry,
  deleteEntry,
  getVersions,
  getDraft,
  saveDraft,
  deleteDraft,
  getStats,
  setBio,
}

///////////////////////////////////////////////////////////////////////////////

const API_URL_BASE = '/.netlify/functions'

const ENDPOINTS = {
  name: API_URL_BASE + '/name',
  idFromName: (name) => API_URL_BASE + '/name/' + name,
  user: (name) => API_URL_BASE + '/user/' + name,
  entries: (type, username, limit) => `${API_URL_BASE}/entries/${type}/${username}${limit ? `/${limit}` : ''}`,
  searchWorks: (type, query) => `${API_URL_BASE}/works/search/${type}/${query}`,
  retrieveWork: (type, apiRef) => `${API_URL_BASE}/works/retrieve/${type}/${apiRef}`,
  createEntry: (type) => `${API_URL_BASE}/entries/${type}`,
  updateEntry: (type, dbRef) => `${API_URL_BASE}/entries/${type}/${dbRef}`,
  deleteEntry: (type, dbRef) => `${API_URL_BASE}/entries/${type}/${dbRef}`,
  stats: (username) => `${API_URL_BASE}/stats/${username}`,
  bio: `${API_URL_BASE}/bio/`,
  retrieveReview: (type, entryRef) => `${API_URL_BASE}/reviews/${type}/${entryRef}`,
  versions: (type, dbRef) => `${API_URL_BASE}/revisions/${type}/${dbRef}`,
  draft: (type, dbRef) => `${API_URL_BASE}/revisions/${type}/${dbRef}/draft`,
}
