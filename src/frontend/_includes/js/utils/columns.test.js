/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads columns.js into a vm context with the
 * globals it expects and pulls the formatter out of the script's scope.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "columns.js"), "utf8");
const generalSource = fs.readFileSync(path.join(__dirname, "general.js"), "utf8");

// The real `Utils`, not a stub: `escapeHtml` and `toSafeUrl` are most of what
// the formatters below are being asked about, so a stand-in for them would be
// testing the stand-in. `URL` is a host global rather than a JS builtin, so a
// fresh vm context has to be handed one.
//
// `wrapInIife` in `asset_plan.js` wraps each bundled file in its own IIFE,
// which is what keeps two files' `const`s from colliding and what makes an
// assignment with no keyword (`Utils = …`) the only thing that crosses between
// them. Loading them the same way here keeps that difference visible.
const context = vm.createContext({
  URL,
  console,
  Conversions: { apiTypeToType: {}, statusToTitle: () => "" },
});
const load = (js, exports) =>
  vm.runInContext(`(() => {\n${js}\n;return ${exports}\n})()`, context);

load(generalSource, "undefined");

const { playtimeFormatter, titleFormatter, listOfLinksFormatter, Columns } =
  load(
    source,
    "({ playtimeFormatter, titleFormatter, listOfLinksFormatter, Columns })"
  );

const playtime = (commonMetadata, overrides) =>
  playtimeFormatter(null, { commonMetadata, overrides });

const title = (commonMetadata, overrides) =>
  titleFormatter(null, { dbRef: "abc", commonMetadata, overrides });

const genres = (values) =>
  listOfLinksFormatter("genres")(null, { commonMetadata: { genres: values } });

test("a flat hltb apiRef links the playtime to HowLongToBeat", () => {
  assert.equal(
    playtime({ duration: 600, apiRefs: ["igdb__1", "hltb__555"] }),
    '<a href="https://howlongtobeat.com/game?id=555">10h</a>'
  );
});

test("the externalUrls link wins over the apiRef", () => {
  assert.equal(
    playtime({
      duration: 630,
      apiRefs: ["igdb__1", "hltb__555"],
      externalUrls: [
        { name: "igdb", url: "https://igdb.com/x" },
        { name: "hltb", url: "https://howlongtobeat.com/game?id=999" },
      ],
    }),
    '<a href="https://howlongtobeat.com/game?id=999">10h&frac12</a>'
  );
});

test("apiRefs still stored as objects are understood", () => {
  assert.equal(
    playtime({ duration: 600, apiRefs: [{ name: "hltb", ref: "77" }] }),
    '<a href="https://howlongtobeat.com/game?id=77">10h</a>'
  );
});

test("without an hltb ref the playtime links to a search instead", () => {
  // 210 games are in this state: a HowLongToBeat-era playtime with no
  // `hltb__` ref beside it. They were the only playtimes on the site with no
  // link at all, and the ids can no longer be fetched to fill in (#201).
  assert.equal(
    playtime({
      duration: 600,
      englishTranslatedTitle: "Arx Fatalis",
      apiRefs: ["igdb__1"],
    }),
    '<a href="https://howlongtobeat.com/?q=Arx%20Fatalis&amp;t=games">10h</a>'
  );
});

test("the search falls back to the original title", () => {
  assert.equal(
    playtime({ duration: 600, originalTitle: "赤マント" }),
    '<a href="https://howlongtobeat.com/?q=%E8%B5%A4%E3%83%9E%E3%83%B3%E3%83%88' +
      '&amp;t=games">10h</a>'
  );
});

test("a playtime on a work with no title at all stays plain text", () => {
  // Nothing to search for, so there is nowhere honest to point.
  assert.equal(playtime({ duration: 600, apiRefs: ["igdb__1"] }), "10h");
});

test("a stored hltb page still beats the search", () => {
  assert.equal(
    playtime({
      duration: 600,
      englishTranslatedTitle: "Arx Fatalis",
      apiRefs: ["hltb__555"],
    }),
    '<a href="https://howlongtobeat.com/game?id=555">10h</a>'
  );
});

test("a work with no metadata at all doesn't throw", () => {
  assert.equal(playtime({}), "-");
  assert.equal(playtime({ apiRefs: ["hltb__5"] }), "-");
});

test("a user's duration override still wins over the cached metadata", () => {
  assert.equal(
    playtime({ duration: 600, apiRefs: ["hltb__5"] }, { duration: 120 }),
    '<a href="https://howlongtobeat.com/game?id=5">2h</a>'
  );
});

test("an IGDB-sourced playtime links to the IGDB page it came from", () => {
  assert.equal(
    playtime({
      duration: 600,
      durationSource: "igdb",
      apiRefs: ["igdb__14593"],
      externalUrls: [{ name: "igdb", url: "https://www.igdb.com/games/hk" }],
    }),
    '<a href="https://www.igdb.com/games/hk">10h</a>'
  );
});

test("an IGDB-sourced playtime does not borrow a HowLongToBeat link", () => {
  // The hltb page is still worth linking to from the title, but it is not
  // where this number came from, and the two disagree by ~10%.
  assert.equal(
    playtime({
      duration: 600,
      durationSource: "igdb",
      apiRefs: ["igdb__14593", "hltb__26286"],
      externalUrls: [{ name: "hltb", url: "https://howlongtobeat.com/game?id=26286" }],
    }),
    "10h"
  );
});

test("a playtime with no recorded source still links to HowLongToBeat", () => {
  // 775 games were cached before provenance was recorded; theirs came from
  // HowLongToBeat, and their links are unaffected by any of this.
  assert.equal(
    playtime({ duration: 600, apiRefs: ["igdb__1", "hltb__555"] }),
    '<a href="https://howlongtobeat.com/game?id=555">10h</a>'
  );
});

test("an IGDB-sourced playtime with no IGDB url is plain text", () => {
  assert.equal(
    playtime({ duration: 600, durationSource: "igdb", apiRefs: ["igdb__14593"] }),
    "10h"
  );
});

test("a placeholder hltb ref is searched for, not linked to", () => {
  // 27 games in the database carry `hltb__N/A`; linking to
  // howlongtobeat.com/game?id=N/A would be a dead link on every one of them,
  // so the placeholder counts as no id and the title is searched instead.
  const searched =
    '<a href="https://howlongtobeat.com/?q=Cultic&amp;t=games">10h</a>';
  const game = (apiRefs) =>
    playtime({ duration: 600, englishTranslatedTitle: "Cultic", apiRefs });

  assert.equal(game(["hltb__N/A"]), searched);
  assert.equal(game(["hltb__"]), searched);
  assert.equal(game([{ name: "hltb", ref: "N/A" }]), searched);
});

///////////////////////////////////////////////////////////////////////////////
// Escaping. Everything below is metadata: whatever an external API holds, or
// whatever the owner typed into an override. A list is public, so an override
// that reached the markup intact would run in every reader's browser.

test("an ordinary title renders a closed link and the placeholder cover", () => {
  assert.equal(
    title({ englishTranslatedTitle: "Hollow Knight" }),
    '<span id="entry-abc" class="title-with-cover">' +
      '<img class="mini-thumb" src="/img/mawaru.png" loading="lazy" decoding="async" alt="">' +
      '<a href="http://en.wikipedia.org/wiki/Special:Search?search=Hollow%20Knight&amp;go=Go">' +
      "Hollow Knight</a></span>"
  );
});

test("a title cannot inject markup into a list", () => {
  const rendered = title({
    englishTranslatedTitle: '<img src=x onerror="alert(1)">',
  });
  assert.ok(!rendered.includes("<img src=x"));
  assert.ok(rendered.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("an imageUrl override cannot break out of the src attribute", () => {
  const rendered = title(
    { englishTranslatedTitle: "Hollow Knight" },
    { imageUrl: '/x.png" onerror="alert(1)' }
  );
  assert.ok(!rendered.includes('onerror="alert(1)'));
  assert.ok(rendered.includes('src="/x.png&quot; onerror=&quot;alert(1)"'));
});

test("a javascript: url never reaches an href or a src", () => {
  // Escaping alone would leave this one intact — nothing in it needs escaping.
  const rendered = title(
    { englishTranslatedTitle: "Hollow Knight" },
    {
      imageUrl: "javascript:alert(1)",
      externalUrls: [{ url: "javascript:alert(1)" }],
    }
  );
  assert.ok(!rendered.includes("javascript:"));
  assert.ok(rendered.includes('src="/img/mawaru.png"'));
  assert.ok(rendered.includes("en.wikipedia.org"));
});

test("an http externalUrl is still used as the title's link", () => {
  const rendered = title({
    englishTranslatedTitle: "Hollow Knight",
    externalUrls: [{ url: "https://www.igdb.com/games/hollow-knight" }],
  });
  assert.ok(rendered.includes('href="https://www.igdb.com/games/hollow-knight"'));
});

test("a javascript: playtime link is dropped, leaving plain text", () => {
  assert.equal(
    playtime({
      duration: 600,
      externalUrls: [{ name: "hltb", url: "javascript:alert(1)" }],
    }),
    "10h"
  );
});

test("a title cannot break out of its playtime search link", () => {
  const rendered = playtime({
    duration: 600,
    englishTranslatedTitle: '"><script>alert(1)</script>',
  });
  assert.ok(!rendered.includes("<script>"));
  assert.ok(rendered.includes("%22%3E%3Cscript%3E"));
});

test("a genre cannot break out of its wikipedia link", () => {
  const rendered = genres(['"><script>alert(1)</script>']);
  assert.ok(!rendered.includes("<script>"));
  assert.ok(rendered.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("an ampersand in a name is searched for, not read as a parameter", () => {
  assert.equal(
    genres(["Rock & Roll"]),
    '<a href="http://en.wikipedia.org/wiki/Special:Search?search=Rock%20%26%20Roll&amp;go=Go">' +
      "Rock &amp; Roll</a>"
  );
});

test("the edit button carries the row's id and nothing else", () => {
  const rendered = Columns.edit()
    .formatter(null, {
      status: "Completed",
      dbRef: "abc",
      commonMetadata: { englishTranslatedTitle: "Hollow Knight" },
    }, 0)
    .trim();
  assert.ok(!rendered.includes("Hollow Knight"));
  assert.equal(
    rendered,
    '<i id="edit-Completed-0" class="fas fa-edit edit-button" ' +
      'onclick="window.editEntry(&quot;abc&quot;)"></i>'
  );
});

test("a quote in a dbRef stays inside the string the attribute holds", () => {
  const rendered = Columns.edit()
    .formatter(null, { status: "Completed", dbRef: `a"b'c` }, 0)
    .trim();
  assert.ok(rendered.includes(`onclick="window.editEntry(&quot;a\\&quot;b&#39;c&quot;)"`));
});

test("what the browser parses out of the edit attribute is the dbRef itself", () => {
  const dbRef = `a"b'c`;
  const rendered = Columns.edit()
    .formatter(null, { status: "Completed", dbRef }, 0)
    .trim();

  // A browser HTML-decodes an attribute value and then hands the result to the
  // JS parser, so that is the order to undo it in. Asserting on the escaped
  // text alone cannot tell a correct escape from one that merely looks busy.
  const decoded = rendered
    .match(/onclick="([^"]*)"/)[1]
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

  const argument = decoded.slice("window.editEntry(".length, -1);
  assert.equal(JSON.parse(argument), dbRef);
});
