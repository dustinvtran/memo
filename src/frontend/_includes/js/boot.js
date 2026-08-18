/**
 * @file Draws the page. This is the last file in the bundle, and it has to be:
 * it reaches for `Components.Router`, which every file above it builds up.
 *
 * It used to be an inline <script> at the end of <body>, and that is what kept
 * `<script src="/js/bundle.js">` in <head> from carrying `defer` — a deferred
 * script runs after the parser is done, which is to say after an inline one, so
 * `Components` was not there yet when the inline block asked for it. Bundling
 * these lines puts them back in order and lets the tag defer, which stops it
 * blocking the parser on a page whose entire body is drawn by it.
 */
// The 0 timeout is necessary to detect netlify auth token
window.setTimeout(async () => {
  // Include the router
  Components.setContent('#site', Components.Router())
}, 0)
