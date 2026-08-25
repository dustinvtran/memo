/**
 * @file A minimalistic Netlify router that matches on
 * HTTP verb and number of URL segments
 */
/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('@netlify/functions').HandlerContext} Context */
/** @typedef {import('./utils/responses').Response} Response */
/** @typedef {import('./utils/errors').Error} Error */
/** @typedef {import('./utils/parsers').ValidCollection} ValidCollection */
import { match } from 'ts-pattern'
import { length } from 'ramda'
import { pair } from './utils/general.js'
import { getUrlSegments } from './controllers/utils.js'
/**
 * This is the main routing utility we use in our Netlify functions.
 * Refer to the ts-pattern API to understand how it works, but the
 * provided example should suffice.
 * ts-pattern API: https://github.com/gvergnaud/ts-pattern
 * @param {Event} event
 * @example
 *     matchVerbAndNumberOfUrlSegments(event)
 *      .with(['GET', 1], () => someExternalController(event, context))
 *      .with(['POST', 0], () => someOtherControllerFunction(event, context))
 *      .otherwise(() => responses.notFound())
 */
const matchVerbAndNumberOfUrlSegments = (event) =>
  match(pair([event.httpMethod, length(getUrlSegments(event))]))

export {
  matchVerbAndNumberOfUrlSegments,
}