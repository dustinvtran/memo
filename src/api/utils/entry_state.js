/**
 * @file The states an entry may be in, and what each one is allowed to carry.
 *
 * `personal_fields.js` has had these rules in the browser since #56, and the
 * server had none of them — so they held only for saves made through the form,
 * and only while the form was the thing doing the saving. The audit found 42
 * entries in states they forbid. Most predate the rules; the point of this
 * module is that "predates the rule" stops being a thing that can happen.
 *
 * **Nothing here clears a field, and that is the whole design.** The obvious
 * implementation is to drop what a status forbids — the status is what the
 * user just chose, the stale date is the leftover, so tidy it away. That is
 * wrong for one reason: it is silent. A date someone typed disappears, the
 * save succeeds, and nothing ever says so. Refusing instead costs the user one
 * round trip and a sentence to read, and leaves them to delete the field
 * themselves, which means they know it happened. A tidy-up you did not ask for
 * is indistinguishable from data loss when you find it six months later.
 *
 * So every rule below returns a reason, and every reason becomes a 400 with
 * that sentence in it.
 */

const isSet = (value) => value !== null && value !== undefined

/** Fields each status may not carry, in the order they should be reported. */
const FORBIDDEN = {
  Planned: ['startedDate', 'completedDate', 'progress'],
  Dropped: ['completedDate'],
  // Not finished, so there is no day it was finished on. One entry in
  // production is in this state and it predates the rule, like the other 42.
  InProgress: ['completedDate'],
}

const LABEL = {
  startedDate: 'a started date',
  completedDate: 'a completed date',
  progress: 'progress',
}

const list = (parts) => parts.length < 2
  ? parts.join('')
  : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/**
 * Why this entry cannot be stored, or `undefined` if it can.
 *
 * The four rules, and what separates them from each other:
 *
 * - **A status carrying a field it forbids.** `Planned` means not started, so
 *   neither date nor a progress belongs on it; `Dropped` means not finished,
 *   so a completed date does not. These are the ones a clearing would have
 *   handled, and the ones this deliberately refuses instead.
 * - **`Completed` with no completed date.** The opposite shape: the missing
 *   field is the one that matters and no default is honest. The form fills in
 *   today's date the moment a status becomes `Completed`, so a save made
 *   through it never sees this; what it catches is a caller that skips the
 *   form, which is how the nine such entries in production got there.
 * - **A date pair in the wrong order.** Either date could be the typo. The two
 *   Fallout DLCs the audit turned up were a month apart in both directions and
 *   only their owner could say which field held the wrong month. Equal dates
 *   are fine — finishing something the day you started it is the commonest
 *   shape in this database.
 *
 * One reason at a time, most-specific first, because the message goes in front
 * of a person and a list of four complaints about one form is worse than one.
 *
 * `work` is the document the entry points at, and only the last two rules need
 * it. **Three values, not two**: the work itself, `null` for a caller that
 * looked the `workRef` up and found nothing, and `undefined` for one that did
 * not look. A caller that did not look skips both rules rather than guessing —
 * an entry written before the databases had the thing is a deliberate shape,
 * not a fault, and has no release year to be before.
 *
 * @type {(entry: any, work?: any) => string | undefined}
 */
const impossibleStateReason = (entry, work) => {
  const { status, startedDate: started, completedDate: completed } = entry ?? {}

  const forbidden = (FORBIDDEN[status] ?? []).filter((field) => isSet(entry[field]))
  if (forbidden.length > 0) {
    return `${article(status)} ${status} entry cannot have ${list(forbidden.map((field) => LABEL[field]))}`
  }
  if (status === 'Completed' && !isSet(completed)) {
    return 'a Completed entry needs a completed date'
  }
  if (isSet(started) && isSet(completed) && completed < started) {
    return 'the completed date is before the started date'
  }

  // A `workRef` naming nothing is the dangling reference the audit counts, and
  // the cheapest moment to refuse one is the save that would create it.
  //
  // `null` is the whole signal: a caller that looked and found nothing passes
  // it, and one that did not look passes `undefined`. Without the distinction
  // every caller without a work in hand would be told its entry is broken.
  if (work === null && isSet(entry?.workRef) && entry.workRef !== '') {
    return `it points at a work (${entry.workRef}) that does not exist`
  }

  const year = releaseYear(entry, work)
  if (year) {
    for (const [field, when] of [['startedDate', started], ['completedDate', completed]]) {
      if (!isSet(when)) continue
      const on = new Date(when).getUTCFullYear()
      if (on < year) {
        return `${LABEL[field]} of ${on} is before ${displayName(entry, work)} came out in ${year}`
          + ' — move the date, or override the release year if that is what is wrong'
      }
    }
  }

  return undefined
}

/**
 * The release year to measure a date against: the entry's own override first,
 * then the work's.
 *
 * The override is the point. A game in early access is playable years before
 * the release the databases record — Slay the Spire is 2017 against IGDB's
 * 2019 — and overriding the year is how its owner says so. Measuring against
 * the work anyway would refuse the very correction that fixes it, which is
 * what turns this from a rule into a wall. #361.
 */
const releaseYear = (entry, work) =>
  Number(entry?.overrides?.releaseYear) || Number(work?.releaseYear) || undefined

/** `an InProgress entry`, `a Planned entry`. */
const article = (status) => (/^[AEIOU]/i.test(String(status ?? '')) ? 'an' : 'a')

/** What to call the work in a message, without ever saying "undefined". */
const displayName = (entry, work) => {
  const name = entry?.overrides?.englishTranslatedTitle ?? work?.englishTranslatedTitle
  return typeof name === 'string' && name.trim() !== '' ? `"${name.trim()}"` : 'the work'
}

/**
 * The name an entry is filed under, or `null` when it has none.
 *
 * A show's seasons are several entries on one work document, told apart by a
 * title override - `Succession: Season 1` beside `Succession: Season 2`. So the
 * pair that identifies an entry is the work *and* this, and an absent, null or
 * blank override are one value between them: all three render as the work's own
 * title, so all three are the same row to the person looking at the list.
 *
 * It lives here rather than in the controller that had it because
 * src/db_maintenance needs the same answer: a backfill that moves an entry onto
 * a work is subject to the rule the API enforces, and a second copy of three
 * lines is how the two would come to disagree about what a duplicate is.
 * @type {(entry: any) => string | null}
 */
const filedAs = (entry) => {
  const name = entry?.overrides?.englishTranslatedTitle
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
}

export { impossibleStateReason, filedAs, FORBIDDEN }
