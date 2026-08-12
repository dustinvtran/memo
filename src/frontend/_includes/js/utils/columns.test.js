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

const playtimeFormatter = vm.runInContext(
  `${source}\n;playtimeFormatter`,
  vm.createContext({
    Utils: { html: (strings) => strings.raw.join("") },
    Conversions: { apiTypeToType: {}, statusToTitle: () => "" },
    console,
  })
);

const playtime = (commonMetadata, overrides) =>
  playtimeFormatter(null, { commonMetadata, overrides });

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

test("without an hltb ref the playtime is plain text", () => {
  assert.equal(playtime({ duration: 600, apiRefs: ["igdb__1"] }), "10h");
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

test("a placeholder hltb ref renders no link at all", () => {
  // 27 games in the database carry `hltb__N/A`; linking to
  // howlongtobeat.com/game?id=N/A would be a dead link on every one of them.
  assert.equal(playtime({ duration: 600, apiRefs: ["hltb__N/A"] }), "10h");
  assert.equal(playtime({ duration: 600, apiRefs: ["hltb__"] }), "10h");
  assert.equal(
    playtime({ duration: 600, apiRefs: [{ name: "hltb", ref: "N/A" }] }),
    "10h"
  );
});
