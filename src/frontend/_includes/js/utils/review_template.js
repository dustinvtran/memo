/**
 * @file The first draft an empty note starts from.
 *
 * Game notes all follow the same shape — a summary, then a section per facet,
 * then the running lists of details — and retyping that scaffolding before
 * every note is the boring part of writing one. So an empty note opens with
 * the scaffolding already in it, as a suggestion: it is ordinary text in the
 * textarea, and deleting it is deleting text.
 *
 * Only a note with nothing in it gets one. A note that has been written in,
 * however little, is never touched.
 */

/** The shape every game note follows. */
const GAME_TEMPLATE = [
  'Summary paragraph here.',
  '',
  '__Writing.__',
  '',
  '__Gameplay.__',
  '',
  '__Visuals & Audio.__',
  '',
  '__Details I like:__',
  '',
  '+ N/A',
  '',
  "__Details I'm ambivalent about:__",
  '',
  '+ N/A',
  '',
  "__Details I don't like:__",
  '',
  '+ N/A',
  '',
  '## Resources and Miscellanea',
  '',
].join('\n')

/** Templates by entry type. A type without one starts from a blank note. */
const templates = {
  games: GAME_TEMPLATE,
}

/**
 * What the comments field should open with, given whatever text the note
 * already holds.
 *
 * @type {(type: string, text?: string | null) => string}
 */
const initialReviewText = (type, text) =>
  (text ?? '').trim() === '' ? templates[type] ?? '' : text

ReviewTemplate = {
  initialReviewText,
}
