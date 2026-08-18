/**
 * @file Whether a single-document read found anything.
 *
 * `findFirst` in ./unsafe_functions.js reports "no such document" as `{}`
 * rather than as `null`, because most callers here treat absence as a normal
 * answer: `user.js` and `name.js` test `?.data` and answer 200 with an empty
 * body, which is what the profile page turns into its own 404. That
 * convention is only a trap for the callers that treat absence as a *failure*
 * and reach straight into what came back — `{}.data.userId` throws, and inside
 * a neverthrow callback that throw leaves as a rejected promise. See #139.
 *
 * So the test lives here, once, instead of being spelled out by hand at each
 * site that needs it. `ref.id` and not `data`: a document always has a `ref`,
 * and the `users` document a brand-new account gets from `create_` has no
 * fields on it worth speaking of yet.
 *
 * Dependency-free on purpose — the suite runs with no install (see CLAUDE.md).
 */

/** @type {(document: any) => boolean} */
const isFound = (document) => Boolean(document?.ref?.id)

module.exports = {
  isFound,
}
