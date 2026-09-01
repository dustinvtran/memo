/**
 * The component styles already written into `#component-styles`, so that
 * deciding whether to append one is a lookup rather than a read of the
 * document. Both it and the tag last as long as the page: nothing removes the
 * tag, and each navigation is a full load, so the two cannot drift apart.
 *
 * What this replaced was `styleTag.html().includes(componentStyle)`, which
 * pulled the whole accumulated stylesheet into a string on every
 * `initComponent` call — including for the components that have no style at
 * all, which is most of them, and which were asking a growing string whether
 * it contained `undefined`.
 *
 * It only bounds the tag because the styles put in it are the same text every
 * time. A style that interpolates the instance `id` is a new string per
 * instance, so it can never be found here and is appended again forever; that
 * is what `#overlay-${parentId}` and the entry form's buttons used to do, and
 * why they now name a class instead.
 */
const appendedStyles = new Set()

const { html, raw } = Utils
const { el } = Dom

/** The magic function to create and compose components */
const initComponent = ({ content, initializer, style }) => {
  let includeList = []

  // Include the component HTML inside another, but also remember to
  // include that component's JS/initializer inside the parent's
  // This function is provided as a parameter to `content`
  //
  // `raw`, because what comes back is markup and the parent is about to
  // interpolate it into an `html` template that escapes anything unbranded.
  // Each `content` below has already been through `html` itself, so a child's
  // own data was escaped when it was drawn; this only says that the drawing is
  // finished.
  const include = (componentOrComponents) =>
    raw(
      [componentOrComponents]
        .flat()
        .map((component) => {
          const unwrapped = access(component)
          includeList = [...includeList, unwrapped]
          return String(unwrapped.content)
        })
        .join('')
    )

  // Generate a identifier unique to that component's instance
  // This is passed to `content`, `initializer` and `style`
  const id = uniqueId()

  // The <style> the component styles below are collected into, created on
  // first use. It is this component system's own tag, named rather than found
  // with a `head style` selector: litepicker injects a <style> of its own at
  // the top of <head>, and whichever of the two got there first used to decide
  // where every component style landed. Appended, so it sits after the
  // stylesheet <link>s and a component's style wins over main.css.
  const styleTag =
    document.getElementById('component-styles') ??
    document.head.appendChild(
      Object.assign(document.createElement('style'), { id: 'component-styles' })
    )

  // Add the component style to the site if it has not already. The registry
  // below answers that; what the tag already contains is not read back.
  //
  // `append` on the element rather than through a markup string: a stylesheet
  // is not markup, and `>` is the child combinator, which `main.css` and two
  // component styles write. The native `append` puts the text in as text.
  const componentStyle = style?.({ id })
  if (componentStyle && !appendedStyles.has(componentStyle)) {
    appendedStyles.add(componentStyle)
    styleTag.append(componentStyle)
  }

  return hide({
    id,
    // Through `html` rather than taken as it comes: a `content` that returns a
    // plain string is returning text, and text goes into the page as text.
    // `Markdown` in `common.js` is the one component whose content is markup
    // from outside a template, and it says so with `raw`.
    content: html`${content({ id, include })}`,
    // We create a new initializer that also contains the child initializers
    initializer: () => {
      // This component's initializer, with the unique id passed into it
      initializer?.({ id })

      // The child components' initializers
      includeList.forEach(({ initializer, id }) => {
        initializer?.({ id })
      })
    },
  })
}

/**
 * Imperative way to replace an element inner HTML with a component.
 *
 * `target` is a selector or an element: `utils/tables.js` has the comment
 * panel in hand and passes it, rather than building a selector out of an id
 * that came from the database. A selector matching nothing still runs the
 * initializer, which is what `$(selector).html()` on an empty set did.
 */
const setContent = (target, component) => {
  const { content, initializer, id } = access(component)
  // `String`, because `content` is a branded markup object rather than a
  // string since #272 — `innerHTML` would otherwise stringify it as
  // "[object Object]" and put that on the page. It is the one coercion the
  // brand costs, and this is where it belongs: the boundary between the
  // component system and the DOM.
  const node = el(target)
  if (node) node.innerHTML = String(content)
  // Run the component's initializer
  initializer?.()
  return id
}

/** Imperative way to append a component to element inner HTML*/
const appendContent = (target, component) => {
  const { content, initializer, id } = access(component)
  // `insertAdjacentHTML` rather than `innerHTML +=`, which would re-parse what
  // is already there and throw away every listener bound to it — this is how
  // a modal and a notification are put on <body>. `String` for the same reason
  // as `setContent` above.
  const node = el(target)
  if (node) node.insertAdjacentHTML('beforeend', String(content))
  // Run the component's initializer
  initializer?.()
  return id
}


Components = {}
Components.initComponent = initComponent
Components.setContent = setContent
Components.appendContent = appendContent
Components.UI = {}
Components.Home = {}
Components.Profile = {}
Components.List = {}

///////////////////////////////////////////////////////////////////////////////

/** Hide component internals to force consumers to use initComponent/include */
const componentPropAccessor = Symbol()
const hide = (component) => ({ [componentPropAccessor]: component })
const access = (component) => component[componentPropAccessor]

const uniqueId = () => '_' + Math.random().toString(36).substring(2, 9)
