/** @file entries */
/** @typedef {import('@netlify/functions').Handler} Handler */
import * as responses from '../utils/responses.js'
import { getAllEntriesForUser, createNewUserListEntry, updateEntry, deleteEntry } from '../controllers/entries.js'
import { matchVerbAndNumberOfUrlSegments } from '../router.js'
/** @type Handler */
export const handler = async (event, context) =>
  matchVerbAndNumberOfUrlSegments(event)

    // GET /api/entries/:type/:username/:limit?
    .with(['GET', 2], () => getAllEntriesForUser(event))
    .with(['GET', 3], () => getAllEntriesForUser(event))

    // POST /api/entries/:type
    .with(['POST', 1], () => createNewUserListEntry(event))

    // PATCH /api/entries/:type/:dbRef
    .with(['PATCH', 2], () => updateEntry(event))

    // DELETE /api/entries/:type/:dbRef
    .with(['DELETE', 2], () => deleteEntry(event))

    .otherwise(() => responses.notFound())
