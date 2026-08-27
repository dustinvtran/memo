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
  // with `$('head style')`: litepicker injects a <style> of its own at the top
  // of <head>, and whichever of the two got there first used to decide where
  // every component style landed. Appended, so it sits after the stylesheet
  // <link>s and a component's style wins over main.css and bootstrap.
  if ($('#component-styles').length === 0) {
    $('head').append('<style id="component-styles"></style>')
  }
  const styleTag = $('#component-styles')

  // Add the component style to the site if it has not already. The registry
  // below answers that; what the tag already contains is not read back.
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

/** Imperative way to replace an element inner HTML with a component */
const setContent = (selector, component) => {
  const { content, initializer, id } = access(component)
  // Set the inner HTML to the component's content. `String`, because content
  // is markup rather than a string now, and jQuery's `.html()` branches on
  // `typeof value === "string"` — an object goes down the path meant for a
  // callback and silently does something else.
  $(selector).html(String(content))
  // Run the component's initializer
  initializer?.()
  return id
}

/** Imperative way to append a component to element inner HTML*/
const appendContent = (selector, component) => {
  const { content, initializer, id } = access(component)
  // Set the inner HTML to the component's content. `String` for the same
  // reason as `setContent` above.
  $(selector).append(String(content))
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
