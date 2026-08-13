/** The magic function to create and compose components */
const initComponent = ({ content, initializer, style }) => {
  let includeList = []

  // Include the component HTML inside another, but also remember to
  // include that component's JS/initializer inside the parent's
  // This function is provided as a parameter to `content`
  const include = (componentOrComponents) =>
    [componentOrComponents]
      .flat()
      .map((component) => {
        const unwrapped = access(component)
        includeList = [...includeList, unwrapped]
        return unwrapped.content
      })
      .join('')

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

  // Add the component style to the site if it has not already
  const componentStyle = style?.({ id })
  if (!styleTag.html().includes(componentStyle)) {
    styleTag.first().append(componentStyle)
  }

  return hide({
    id,
    content: content({ id, include }),
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
  // Set the inner HTML to the component's content
  $(selector).html(content)
  // Run the component's initializer
  initializer?.()
  return id
}

/** Imperative way to append a component to element inner HTML*/
const appendContent = (selector, component) => {
  const { content, initializer, id } = access(component)
  // Set the inner HTML to the component's content
  $(selector).append(content)
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
