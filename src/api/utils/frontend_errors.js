/** @typedef {(
 * 'NoUsernameSet' | 'NameTaken'
 * )} FrontendErrorName
 */

/** @typedef {{ error: FrontendErrorName, context?: string }} FrontendError */


/** @type {() => FrontendError} */
const noUsernameSet = () => error('NoUsernameSet')

/** @type {(nameRequested: string) => FrontendError} */
const nameTaken = (nameRequested) =>
  error('NameTaken', `${nameRequested} is already taken.`)
  
export {
  noUsernameSet,
  nameTaken
}
///////////////////////////////////////////////////////////////////////////////

/** @type {(error: FrontendErrorName, context?: string) => FrontendError} */
const error = (error, context) => ({ error, context })
