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
 * @type {(entry: any) => string | undefined}
 */
const impossibleStateReason = (entry) => {
  const { status, startedDate: started, completedDate: completed } = entry ?? {}

  const forbidden = (FORBIDDEN[status] ?? []).filter((field) => isSet(entry[field]))
  if (forbidden.length > 0) {
    return `a ${status} entry cannot have ${list(forbidden.map((field) => LABEL[field]))}`
  }
  if (status === 'Completed' && !isSet(completed)) {
    return 'a Completed entry needs a completed date'
  }
  if (isSet(started) && isSet(completed) && completed < started) {
    return 'the completed date is before the started date'
  }
  return undefined
}

export { impossibleStateReason, FORBIDDEN }
