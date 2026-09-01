/**
 * @file The few DOM operations this site does more than once, and nothing else.
 *
 * This is what is left of jQuery, and it is deliberately not a small jQuery:
 * there is no wrapper object, nothing chains, and every function takes and
 * gives back plain nodes. Most of the 111 call sites needed nothing at all —
 * `.val()` is `.value`, `.html()` is `.innerHTML`, `.text()` is `.textContent`,
 * `.addClass`/`.removeClass`/`.toggleClass` are `classList`, and `.closest()`
 * and `.append()` are already native under the same names — so those are
 * written out where they happen rather than wrapped here.
 *
 * What is here is the three things vanilla does not hand you: the tolerance of
 * a missing element that a selector-based API gets for free, a delegated
 * handler that can be installed again without doubling, and the animations.
 * #269.
 */

/** The `$()` half worth keeping: a node from a selector or a node, or `null`. */
const el = (target) =>
  typeof target === 'string' ? document.querySelector(target) : (target ?? null)

const els = (selector, root = document) => [...root.querySelectorAll(selector)]

/**
 * A listener, if the element is there.
 *
 * Every caller binds to something it has just drawn, and several of those are
 * drawn conditionally — the history's "Restore into form" button is not there
 * for the current version, the entry form's date fields are not there for a
 * film. Under `$` a missing element was a no-op; without this it is a
 * `TypeError` that takes the rest of the initializer with it.
 */
const on = (target, event, handler) => {
  const node = el(target)
  node?.addEventListener(event, handler)
  return node
}

const onClick = (target, handler) => on(target, 'click', handler)

/**
 * A delegated click on `document`, replacing whatever was registered under the
 * same `name`.
 *
 * This is `$(document).off('click.entryRows').on('click.entryRows', …)` in
 * `components/list/list.js`, and both halves of it are load-bearing.
 * Delegation, because the rows it listens for are destroyed and rebuilt on
 * every search, sort and column toggle — and because `script-src` in `_headers`
 * grants neither `'unsafe-inline'` nor `'unsafe-eval'`, so the handler cannot
 * move into the markup instead (#219). Replacing rather than adding, because
 * that initializer runs on every render and a second copy of the edit handler
 * opens two modals on one click.
 *
 * `name` is jQuery's event namespace under another spelling: it is the thing
 * that says which handler this one is the newer copy of.
 */
const delegatedClicks = new Map()

const delegateClick = (name, selector, handler) => {
  const previous = delegatedClicks.get(name)
  if (previous) document.removeEventListener('click', previous)

  // The matched element is passed rather than left to be read off the event:
  // jQuery reported it as `currentTarget`, which on a listener bound to
  // `document` is `document`.
  const listener = (event) => {
    const match = event.target.closest?.(selector)
    if (match) handler(match, event)
  }

  delegatedClicks.set(name, listener)
  document.addEventListener('click', listener)
}

/**
 * jQuery's `:visible`, near enough for what asks. `offsetParent === null` is
 * the usual shortcut and answers wrongly for a fixed-position element, which
 * the modal and the notification both are.
 */
const isVisible = (node) => Boolean(node) && getComputedStyle(node).display !== 'none'

/**
 * `hide` writes `display: none` inline and `show` takes that declaration back
 * off, which is what jQuery did and what every caller here wants: each of these
 * elements is hidden by an inline `display: none` in its own markup, so
 * removing the declaration hands the answer back to the stylesheet — `flex`
 * for the draft banner, `block` for the rest.
 */
const show = (target) => {
  const node = el(target)
  if (node) node.style.display = ''
}

const hide = (target) => {
  const node = el(target)
  if (node) node.style.display = 'none'
}

/**
 * The animations, which are the part of jQuery with no one-line replacement.
 *
 * jQuery measured the element and animated to that number, and it had to: a CSS
 * transition needs two lengths and `height: auto` is not one, so a panel
 * transitioning from `auto` does not move at all. The same measurement is what
 * these do, in about forty lines and with nothing in the stylesheet that has to
 * cooperate.
 *
 * Each of them ends by setting something that is not an animated property —
 * `display: none`, or clearing the `overflow` the slide needed — so the end has
 * to be run when the animation is over. `settle` below is what runs it, and
 * what makes that safe against a second click and against a background tab.
 */
const fadeIn = (node, duration) => {
  if (!node) return
  cancelAnimations(node)
  show(node)
  node.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASING })
}

const fadeOut = (node, duration) => {
  if (!node || !isVisible(node)) return
  cancelAnimations(node)
  settle(
    node,
    node.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: EASING }),
    duration,
    () => hide(node)
  )
}

const slideDown = (node, duration) => {
  if (!node) return
  cancelAnimations(node)
  // Shown before it is measured: a `display: none` element is nothing tall.
  show(node)
  slide(node, COLLAPSED_BOX, openBox(node), duration)
}

const slideUp = (node, duration) => {
  if (!node || !isVisible(node)) return
  cancelAnimations(node)
  slide(node, openBox(node), COLLAPSED_BOX, duration, () => hide(node))
}

const slideToggle = (node, duration) =>
  isVisible(node) ? slideUp(node, duration) : slideDown(node, duration)

Dom = {
  el,
  els,
  on,
  onClick,
  delegateClick,
  isVisible,
  show,
  hide,
  fadeIn,
  fadeOut,
  slideDown,
  slideUp,
  slideToggle,
}

///////////////////////////////////////////////////////////////////////////////

const EASING = 'ease'

/**
 * Runs `done` once this animation is over, unless another one has taken the
 * node over in the meantime.
 *
 * Two things have to be true and neither is free.
 *
 * A second click cancels the running animation, and `finished` *rejects* when
 * that happens — so a cancelled slide must not run its own end and shut a panel
 * that is on its way open. The registry below is what answers that: the end
 * belongs to whichever animation the node is currently registered under.
 *
 * And `finished` does not settle at all while the document is not being
 * rendered — a background tab pauses its animations, and the promise waits for
 * as long as the reader is looking at something else. Timers are not paused
 * that way, so the timeout is what makes the end arrive regardless; the
 * registry makes running it twice harmless, since the second caller finds the
 * node already unregistered.
 */
const running = new WeakMap()

/** Enough for the animation itself to have got there first when it can. */
const SETTLE_GRACE_MS = 30

const settle = (node, animation, duration, done) => {
  running.set(node, animation)

  const end = () => {
    if (running.get(node) !== animation) return
    running.delete(node)
    done()
  }

  animation.finished.then(end, () => undefined)
  setTimeout(end, duration + SETTLE_GRACE_MS)
}

/** Whatever is already animating this node, so it cannot fight the new one. */
const cancelAnimations = (node) => node.getAnimations().forEach((a) => a.cancel())

/**
 * The padding and the margins collapse with the height, as they did under
 * jQuery. Without them a panel with `padding: 12px 14px` — the history's
 * version detail — stops 24px short of gone and whatever is under it jumps the
 * rest of the way.
 */
const COLLAPSED_BOX = {
  height: '0px',
  paddingTop: '0px',
  paddingBottom: '0px',
  marginTop: '0px',
  marginBottom: '0px',
}

const openBox = (node) => {
  const style = getComputedStyle(node)
  return {
    height: `${heightOf(node, style)}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
  }
}

/**
 * The number to give the `height` property, which is not the same number under
 * the two box models: `offsetHeight` is always the border box, and `height`
 * only means that under `box-sizing: border-box`. `main.css` sets that on
 * everything, as Bootstrap did before it, but this asks rather than assuming —
 * being wrong about it shows up as a panel that clips its last line, not as
 * anything that fails.
 */
const heightOf = (node, style) =>
  style.boxSizing === 'border-box'
    ? node.offsetHeight
    : node.offsetHeight -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom) -
      parseFloat(style.borderTopWidth) -
      parseFloat(style.borderBottomWidth)

/**
 * `overflow: hidden` for the duration, or the content spills out of an element
 * shorter than it is. Cleared only on a finish, so a slide interrupted by
 * another one leaves the clearing up to whichever one gets to the end.
 */
const slide = (node, from, to, duration, done) => {
  node.style.overflow = 'hidden'
  settle(node, node.animate([from, to], { duration, easing: EASING }), duration, () => {
    node.style.overflow = ''
    done?.()
  })
}
