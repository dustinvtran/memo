/**
 * @file The thirteen icons the markup draws, as inline SVG.
 *
 * These used to be `<i class="fas fa-edit">` against Font Awesome's
 * stylesheet, which `layouts/base.njk` loaded from cdnjs. That was 73,890
 * bytes of CSS naming two thousand icons, and it then fetched the faces the
 * glyphs actually live in: `fa-solid-900.woff2` is 158,220 bytes and
 * `fa-regular-400.woff2` a further 25,472, both of them measured being
 * fetched by a list page. Around 257 KB to draw the thirteen below, which was
 * the largest single thing left on the page by some distance. #269.
 *
 * The paths are Font Awesome Free 6.7.2's own, copied out of
 * `@fortawesome/fontawesome-free@6.7.2/svgs/<weight>/<file>.svg` — the same
 * release the stylesheet was pinned to, so every glyph is the one that was
 * there rather than something like it. `weight` and `file` are recorded per
 * icon because that pair *is* the path back to the source: the markup's class
 * names are v4 and v5 spellings that 6 keeps as aliases, so `fa-edit` is
 * `solid/pen-to-square.svg` and no file in that set is called `edit`.
 *
 * **Font Awesome Free's icons are CC BY 4.0** (https://fontawesome.com/license
 * /free). Attribution: Font Awesome Free 6.7.2 by @fontawesome —
 * https://fontawesome.com. The five glyphs `_includes/css/main.css` draws
 * through `mask-image` come from the same set and carry the same notice
 * there; the two sets are disjoint, so no path is written down twice.
 *
 * Sizing and colour are `.icon` in `main.css`, and the point of that rule is
 * that neither is decided here: an icon is `1em` tall and `currentColor`, so
 * it takes the size and the colour of the text around it exactly as a glyph
 * in a font did.
 */

const { html } = Utils

/**
 * One icon, as markup.
 *
 * The four options are the four things the call sites need — `class`, `id`,
 * `style` and `data-ref` — rather than an open bag of attributes, because a
 * closed set is one `html` template with the attribute names written as
 * literals in it. Their values are interpolated, so the tag function escapes
 * them (#272), and `icon` hands back a branded value like any other `html`
 * template: returning a bare string would put `<svg>` on the page as text.
 *
 * An unknown name throws rather than drawing nothing. A missing icon is
 * invisible in a screenshot and in a diff of the DOM, and the only other way
 * to find it is to look at every icon on the site.
 * @type {(name: string, options?: { class?: string, id?: string, style?: string, dataRef?: string }) => object}
 */
const icon = (name, { class: classes = '', id, style, dataRef } = {}) => {
  const glyph = GLYPHS[name]
  if (!glyph) throw new Error(`icons: there is no icon named "${name}"`)

  return html`<svg class="${['icon', classes].filter(Boolean).join(' ')}"${
    id ? html` id="${id}"` : ''}${
    style ? html` style="${style}"` : ''}${
    dataRef ? html` data-ref="${dataRef}"` : ''
  } viewBox="${glyph.viewBox}" aria-hidden="true"><path d="${glyph.path}"/></svg>`
}

Icons = { icon }

///////////////////////////////////////////////////////////////////////////////

/**
 * The glyphs, keyed by the name the markup used to say after `fa-`.
 *
 * Every `viewBox` is 512 units tall, which is Font Awesome's em square, and
 * that is what lets `.icon` set `height: 1em` and let the width follow: the
 * drawn width then comes out the same as the glyph's advance did.
 */
const GLYPHS = {
  'arrow-right': {
    weight: 'solid',
    file: 'arrow-right',
    viewBox: '0 0 448 512',
    path: 'M438.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L338.8 224 32 224c-17.7 0-32 14.3-32 32s14.3 32 32 32l306.7 0L233.4 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l160-160z',
  },
  'caret-down': {
    weight: 'solid',
    file: 'caret-down',
    viewBox: '0 0 320 512',
    path: 'M137.4 374.6c12.5 12.5 32.8 12.5 45.3 0l128-128c9.2-9.2 11.9-22.9 6.9-34.9s-16.6-19.8-29.6-19.8L32 192c-12.9 0-24.6 7.8-29.6 19.8s-2.2 25.7 6.9 34.9l128 128z',
  },
  'caret-up': {
    weight: 'solid',
    file: 'caret-up',
    viewBox: '0 0 320 512',
    path: 'M182.6 137.4c-12.5-12.5-32.8-12.5-45.3 0l-128 128c-9.2 9.2-11.9 22.9-6.9 34.9s16.6 19.8 29.6 19.8l256 0c12.9 0 24.6-7.8 29.6-19.8s2.2-25.7-6.9-34.9l-128-128z',
  },
  'chevron-down': {
    weight: 'solid',
    file: 'chevron-down',
    viewBox: '0 0 512 512',
    path: 'M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z',
  },
  'clock-rotate-left': {
    weight: 'solid',
    file: 'clock-rotate-left',
    viewBox: '0 0 512 512',
    path: 'M75 75L41 41C25.9 25.9 0 36.6 0 57.9L0 168c0 13.3 10.7 24 24 24l110.1 0c21.4 0 32.1-25.9 17-41l-30.8-30.8C155 85.5 203 64 256 64c106 0 192 86 192 192s-86 192-192 192c-40.8 0-78.6-12.7-109.7-34.4c-14.5-10.1-34.4-6.6-44.6 7.9s-6.6 34.4 7.9 44.6C151.2 495 201.7 512 256 512c141.4 0 256-114.6 256-256S397.4 0 256 0C185.3 0 121.3 28.7 75 75zm181 53c-13.3 0-24 10.7-24 24l0 104c0 6.4 2.5 12.5 7 17l72 72c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-65-65 0-94.1c0-13.3-10.7-24-24-24z',
  },
  // fa-edit in the markup; 6 renames it and keeps the old one.
  'edit': {
    weight: 'solid',
    file: 'pen-to-square',
    viewBox: '0 0 512 512',
    path: 'M471.6 21.7c-21.9-21.9-57.3-21.9-79.2 0L362.3 51.7l97.9 97.9 30.1-30.1c21.9-21.9 21.9-57.3 0-79.2L471.6 21.7zm-299.2 220c-6.1 6.1-10.8 13.6-13.5 21.9l-29.6 88.8c-2.9 8.6-.6 18.1 5.8 24.6s15.9 8.7 24.6 5.8l88.8-29.6c8.2-2.7 15.7-7.4 21.9-13.5L437.7 172.3 339.7 74.3 172.4 241.7zM96 64C43 64 0 107 0 160L0 416c0 53 43 96 96 96l256 0c53 0 96-43 96-96l0-96c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 96c0 17.7-14.3 32-32 32L96 448c-17.7 0-32-14.3-32-32l0-256c0-17.7 14.3-32 32-32l96 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L96 64z',
  },
  // fa-home in the markup; 6 renames it and keeps the old one.
  'home': {
    weight: 'solid',
    file: 'house',
    viewBox: '0 0 576 512',
    path: 'M575.8 255.5c0 18-15 32.1-32 32.1l-32 0 .7 160.2c0 2.7-.2 5.4-.5 8.1l0 16.2c0 22.1-17.9 40-40 40l-16 0c-1.1 0-2.2 0-3.3-.1c-1.4 .1-2.8 .1-4.2 .1L416 512l-24 0c-22.1 0-40-17.9-40-40l0-24 0-64c0-17.7-14.3-32-32-32l-64 0c-17.7 0-32 14.3-32 32l0 64 0 24c0 22.1-17.9 40-40 40l-24 0-31.9 0c-1.5 0-3-.1-4.5-.2c-1.2 .1-2.4 .2-3.6 .2l-16 0c-22.1 0-40-17.9-40-40l0-112c0-.9 0-1.9 .1-2.8l0-69.7-32 0c-18 0-32-14-32-32.1c0-9 3-17 10-24L266.4 8c7-7 15-8 22-8s15 2 21 7L564.8 231.5c8 7 12 15 11 24z',
  },
  'link': {
    weight: 'solid',
    file: 'link',
    viewBox: '0 0 640 512',
    path: 'M579.8 267.7c56.5-56.5 56.5-148 0-204.5c-50-50-128.8-56.5-186.3-15.4l-1.6 1.1c-14.4 10.3-17.7 30.3-7.4 44.6s30.3 17.7 44.6 7.4l1.6-1.1c32.1-22.9 76-19.3 103.8 8.6c31.5 31.5 31.5 82.5 0 114L422.3 334.8c-31.5 31.5-82.5 31.5-114 0c-27.9-27.9-31.5-71.8-8.6-103.8l1.1-1.6c10.3-14.4 6.9-34.4-7.4-44.6s-34.4-6.9-44.6 7.4l-1.1 1.6C206.5 251.2 213 330 263 380c56.5 56.5 148 56.5 204.5 0L579.8 267.7zM60.2 244.3c-56.5 56.5-56.5 148 0 204.5c50 50 128.8 56.5 186.3 15.4l1.6-1.1c14.4-10.3 17.7-30.3 7.4-44.6s-30.3-17.7-44.6-7.4l-1.6 1.1c-32.1 22.9-76 19.3-103.8-8.6C74 372 74 321 105.5 289.5L217.7 177.2c31.5-31.5 82.5-31.5 114 0c27.9 27.9 31.5 71.8 8.6 103.9l-1.1 1.6c-10.3 14.4-6.9 34.4 7.4 44.6s34.4 6.9 44.6-7.4l1.1-1.6C433.5 260.8 427 182 377 132c-56.5-56.5-148-56.5-204.5 0L60.2 244.3z',
  },
  'location-arrow': {
    weight: 'solid',
    file: 'location-arrow',
    viewBox: '0 0 448 512',
    path: 'M429.6 92.1c4.9-11.9 2.1-25.6-7-34.7s-22.8-11.9-34.7-7l-352 144c-14.2 5.8-22.2 20.8-19.3 35.8s16.1 25.8 31.4 25.8l176 0 0 176c0 15.3 10.8 28.4 25.8 31.4s30-5.1 35.8-19.3l144-352z',
  },
  // fa-plus-square in the markup; 6 renames it and keeps the old one.
  'plus-square': {
    weight: 'regular',
    file: 'square-plus',
    viewBox: '0 0 448 512',
    path: 'M64 80c-8.8 0-16 7.2-16 16l0 320c0 8.8 7.2 16 16 16l320 0c8.8 0 16-7.2 16-16l0-320c0-8.8-7.2-16-16-16L64 80zM0 96C0 60.7 28.7 32 64 32l320 0c35.3 0 64 28.7 64 64l0 320c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96zM200 344l0-64-64 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l64 0 0-64c0-13.3 10.7-24 24-24s24 10.7 24 24l0 64 64 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-64 0 0 64c0 13.3-10.7 24-24 24s-24-10.7-24-24z',
  },
  'rotate-left': {
    weight: 'solid',
    file: 'rotate-left',
    viewBox: '0 0 512 512',
    path: 'M48.5 224L40 224c-13.3 0-24-10.7-24-24L16 72c0-9.7 5.8-18.5 14.8-22.2s19.3-1.7 26.2 5.2L98.6 96.6c87.6-86.5 228.7-86.2 315.8 1c87.5 87.5 87.5 229.3 0 316.8s-229.3 87.5-316.8 0c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0c62.5 62.5 163.8 62.5 226.3 0s62.5-163.8 0-226.3c-62.2-62.2-162.7-62.5-225.3-1L185 183c6.9 6.9 8.9 17.2 5.2 26.2s-12.5 14.8-22.2 14.8L48.5 224z',
  },
  'wave-square': {
    weight: 'solid',
    file: 'wave-square',
    viewBox: '0 0 640 512',
    path: 'M128 64c0-17.7 14.3-32 32-32l160 0c17.7 0 32 14.3 32 32l0 352 96 0 0-160c0-17.7 14.3-32 32-32l128 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-96 0 0 160c0 17.7-14.3 32-32 32l-160 0c-17.7 0-32-14.3-32-32l0-352-96 0 0 160c0 17.7-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32s14.3-32 32-32l96 0 0-160z',
  },
  // fa-window-close in the markup; 6 renames it and keeps the old one.
  'window-close': {
    weight: 'solid',
    file: 'rectangle-xmark',
    viewBox: '0 0 512 512',
    path: 'M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32zM175 175c9.4-9.4 24.6-9.4 33.9 0l47 47 47-47c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-47 47 47 47c9.4 9.4 9.4 24.6 0 33.9s-24.6 9.4-33.9 0l-47-47-47 47c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l47-47-47-47c-9.4-9.4-9.4-24.6 0-33.9z',
  },
}
