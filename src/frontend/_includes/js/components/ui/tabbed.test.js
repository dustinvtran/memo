/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads tabbed.js into a vm context with the
 * globals it expects and pulls `Tabbed` out of the script's scope — the same
 * trick as profile/profile_stats.test.js.
 *
 * What is under test is the click handler, and specifically the `onShow` a
 * page can hand it. A hidden page is `display: none`, so a chart inside one
 * measures zero and keeps that number; being told it is visible is the only
 * thing that lets it draw at a real width. See #282.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "tabbed.js"), "utf8");

/** An element's classes, as far as the handler under test touches them. */
const aClassList = () => {
  const classes = new Set();
  return {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
  };
};

/**
 * The script in a context of its own, with a document made of the two lists of
 * elements its initializer looks up.
 *
 * The stubs exist because the file destructures `Components`, `Utils` and
 * `Dom` at load time and writes itself onto `Components.UI` at the end of it.
 * `initComponent` hands its argument straight back, so the initializer under
 * test is reachable; `content` and `style` are never called, which is why the
 * titles and the contents are built here rather than rendered.
 */
const load = (pageCount) => {
  const state = {
    titles: [...Array(pageCount)].map((_, index) => ({
      dataset: { index: String(index) },
      classList: aClassList(),
      click: undefined,
    })),
    contents: [...Array(pageCount)].map(() => ({ classList: aClassList() })),
  };

  const context = vm.createContext({
    Utils: { html: () => "", css: () => "" },
    Dom: {
      // The initializer looks up the tab titles and, on every click, the tab
      // bodies. Two selectors, told apart by what they end in.
      els: (selector) =>
        selector.endsWith(".tab-title") ? state.titles : state.contents,
      onClick: (target, handler) => {
        target.click = handler;
      },
    },
    Components: {
      initComponent: (component) => component,
      setContent: () => {},
      Div: () => {},
      UI: {},
    },
  });

  const { Tabbed } = vm.runInContext(
    `(() => {\n${source}\n;return ({ Tabbed })\n})()`,
    context
  );

  return { Tabbed, state };
};

/** Two pages wired up and initialized, with the second one listening. */
const twoPages = () => {
  const { Tabbed, state } = load(2);
  const shown = [];
  const pages = [
    { title: "First", component: {} },
    {
      title: "Second",
      component: {},
      onShow: () =>
        // What the second page is told, and whether it could act on it: a
        // chart drawn while its own panel is still `tab-hidden` is a chart
        // drawn at zero width.
        shown.push({ hidden: state.contents[1].classList.contains("tab-hidden") }),
    },
  ];

  Tabbed("Stats", pages).initializer({ id: "_tabs" });
  return { state, shown };
};

test("showing a page tells it so", () => {
  const { state, shown } = twoPages();

  state.titles[1].click();

  assert.equal(shown.length, 1);
});

test("a page is told after it is displayed, not before", () => {
  // The point of the whole notification: it exists so that something inside
  // the page can be measured, and a page still carrying `tab-hidden` has no
  // boxes to measure.
  const { state, shown } = twoPages();

  state.titles[1].click();

  assert.equal(shown[0].hidden, false);
});

test("showing a different page does not tell this one", () => {
  const { state, shown } = twoPages();

  state.titles[0].click();

  assert.equal(shown.length, 0);
  assert.equal(state.contents[1].classList.contains("tab-hidden"), true);
});

test("every reveal is reported, including a click on the open tab", () => {
  // `Tabbed` says what happened rather than deciding what is worth saying;
  // a page that must act once wraps its own listener. See `once` in
  // profile/profile_stats.js.
  const { state, shown } = twoPages();

  state.titles[1].click();
  state.titles[1].click();
  state.titles[0].click();
  state.titles[1].click();

  assert.equal(shown.length, 3);
});

test("a page with no onShow is still just a page", () => {
  // `onShow` is optional and most pages will never have one, so the handler
  // has to survive both a page without one and an index with no page at all.
  const { Tabbed, state } = load(2);
  const pages = [{ title: "First", component: {} }, { title: "Second", component: {} }];

  Tabbed("Stats", pages).initializer({ id: "_tabs" });

  assert.doesNotThrow(() => state.titles[1].click());
  assert.equal(state.contents[1].classList.contains("tab-hidden"), false);
  assert.equal(state.contents[0].classList.contains("tab-hidden"), true);
});
