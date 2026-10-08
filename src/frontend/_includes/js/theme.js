/**
 * @file Which colour scheme the page draws in, decided before it draws. #523.
 *
 * This is the one frontend file that is not in the bundle, and it cannot be.
 * The bundle is deferred, so it runs after the first paint; a choice applied
 * from there is a page that flashes the system's scheme and then swaps. So
 * `layouts/base.njk` loads this on its own, without `defer`, ahead of the
 * stylesheet — a few hundred bytes that block the parser beside two CDN
 * scripts that already do. It cannot be an inline `<script>` instead:
 * `script-src` in `_headers` refuses those, and `bundle.test.js` holds it to
 * that.
 *
 * The choice is kept in this browser's `localStorage`, not on the account.
 * Reading it has to be synchronous to beat the first paint, and an account
 * setting is a network round trip behind a session — so it would have to be
 * copied into the browser anyway, and the copy is the thing that would be
 * read. "System" is a fact about a device rather than a person, too, and a
 * reader who is not signed in still gets a page.
 *
 * The scheme itself is CSS. `main.css` writes every colour as `light-dark()`,
 * which follows the root's `color-scheme`, and that follows the system unless
 * `data-theme` on <html> pins it. So "System" is the absence of the attribute
 * and needs nothing from here at all; this only ever pins a choice.
 *
 * `Theme` is a global like any of the bundle's, and the profile's setting reads
 * it. Every file in the bundle runs after this one, so it is there when they
 * load.
 */
(() => {
  const STORAGE_KEY = 'memo-theme'

  /** The three choices, in the order the setting offers them. */
  const CHOICES = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ]

  const isChoice = (value) => CHOICES.some((choice) => choice.value === value)

  // Storage can throw rather than answer — Safari's private windows used to,
  // and a browser with site data blocked still does — and a page that cannot
  // remember a theme should draw in the system's rather than not at all.
  const read = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return isChoice(stored) ? stored : 'system'
    } catch {
      return 'system'
    }
  }

  const apply = (choice) => {
    const root = document.documentElement
    if (choice === 'light' || choice === 'dark') root.dataset.theme = choice
    else delete root.dataset.theme
  }

  /** Remembers `choice` for this browser and redraws in it at once. */
  const choose = (choice) => {
    const value = isChoice(choice) ? choice : 'system'
    try {
      // "System" is stored as nothing, so it is also what a cleared or
      // unreadable store comes back as.
      if (value === 'system') localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // Applied for this page view regardless; it just will not survive one.
    }
    apply(value)
    return value
  }

  Theme = { STORAGE_KEY, CHOICES, read, choose }

  // `bundle.test.js` runs this file in a vm with no document, to put `Theme`
  // where the bundle's files look for it; there is nothing to apply it to.
  if (typeof document === 'undefined') return

  apply(read())

  // Another tab changing the setting changes this one too, rather than leaving
  // two windows of the same site in two schemes until one of them reloads.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) apply(read())
  })
})()
