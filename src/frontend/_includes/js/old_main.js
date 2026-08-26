/**
 * @file nil's old main file, reduced to the one thing still wired up.
 *
 * `wrapInIife` in `_includes/js/asset_plan.js` gives every bundled file its own
 * IIFE, so a bare `function` here never reaches `window` — which is where
 * bootstrap-table looks when an option names its value as a string.
 * `icons: 'icons'` in the list component resolves to this object; the sorters
 * and formatters that used to sit alongside it resolved to nothing and were
 * removed.
 */
window.icons = {
  detailOpen: 'fa-caret-down',
  detailClose: 'fa-caret-up'
};
