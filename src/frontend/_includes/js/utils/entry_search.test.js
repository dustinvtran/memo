/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this loads entry_search.js into a vm context and
 * pulls the search out of the script's scope.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "entry_search.js"), "utf8");

// base.njk wraps each included file in its own IIFE, which is what keeps two
// files' `const`s from colliding and what makes an assignment with no keyword
// (`EntrySearch = …`) the only thing that crosses between them. Loading it the
// same way here keeps that difference visible.
const { EntrySearch, searchFields } = vm.runInContext(
  `(() => {\n${source}\n;return ({ EntrySearch, searchFields })\n})()`,
  vm.createContext({})
);

const { filterEntries, fieldFor, wasAbandoned } = EntrySearch;

/** The fields of the columns a film list shows before anything is toggled. */
const visibleFilmFields = [
  "commonMetadata.englishTranslatedTitle",
  "score",
  "commonMetadata.releaseYear",
  "commonMetadata.directors",
].map(fieldFor);

/**
 * A row as the table sees it: the entry's own fields at the top, the work's
 * metadata under `commonMetadata` with the overrides already folded in.
 */
const entry = ({ score, completedDate, title, ...metadata }) => ({
  status: "Completed",
  score,
  completedDate,
  commonMetadata: { englishTranslatedTitle: title, ...metadata },
});

const inception = entry({
  title: "Inception",
  releaseYear: 2010,
  directors: ["Christopher Nolan"],
  actors: ["Leonardo DiCaprio", "Elliot Page"],
  score: 7,
  completedDate: Date.UTC(2019, 5, 14),
});

const goldfinger = entry({
  title: "Goldfinger",
  releaseYear: 1964,
  directors: ["Guy Hamilton"],
  // The cast is the reason this film came back from a search for `nolan`.
  actors: ["Sean Connery", "Margaret Nolan"],
  score: 6,
  completedDate: Date.UTC(2021, 0, 2),
});

const thePrestige = entry({
  title: "The Prestige",
  releaseYear: 2006,
  directors: ["Christopher Nolan"],
  actors: ["Hugh Jackman", "Christian Bale"],
  score: 7,
});

const theWitcher = entry({
  title: "The Witcher: Nightmare of the Wolf",
  directors: ["Han Kwang-il"],
  actors: ["Theo James", "Nolan North"],
});

const films = [inception, goldfinger, thePrestige, theWitcher];

const titlesOf = (rows) =>
  rows.map((row) => row.commonMetadata.englishTranslatedTitle);

const search = (query, fields = visibleFilmFields) =>
  titlesOf(filterEntries(films, query, fields));

test("a bare term does not match a column the table is not showing", () => {
  // The complaint in #137: `nolan` returned Goldfinger, Friends with Benefits
  // and The Witcher, because each has a Nolan in the hidden cast column.
  assert.deepEqual(search("nolan"), ["Inception", "The Prestige"]);
});

test("a bare term does match a hidden column once it is shown", () => {
  assert.deepEqual(
    search("nolan", [...visibleFilmFields, fieldFor("commonMetadata.actors")]),
    ["Inception", "Goldfinger", "The Prestige", "The Witcher: Nightmare of the Wolf"]
  );
});

test("a field term matches that field and nothing else", () => {
  assert.deepEqual(search("director:nolan"), ["Inception", "The Prestige"]);
  assert.deepEqual(search("actor:nolan"), [
    "Goldfinger",
    "The Witcher: Nightmare of the Wolf",
  ]);
  // The field is named, so the columns on show have nothing to do with it.
  assert.deepEqual(search("actor:nolan", []), [
    "Goldfinger",
    "The Witcher: Nightmare of the Wolf",
  ]);
});

test("a field term is case-insensitive on both sides", () => {
  assert.deepEqual(search("DIRECTOR:NoLaN"), ["Inception", "The Prestige"]);
});

test("a field term is a regex", () => {
  assert.deepEqual(search('title:"^the "'), [
    "The Prestige",
    "The Witcher: Nightmare of the Wolf",
  ]);
  assert.deepEqual(search("year:^19"), ["Goldfinger"]);
  assert.deepEqual(search("score:^7$"), ["Inception", "The Prestige"]);
});

test("terms are separated by commas and all of them have to match", () => {
  assert.deepEqual(search('title:"^the ",director:nolan'), ["The Prestige"]);
  assert.deepEqual(search("director:nolan, 2010"), ["Inception"]);
  assert.deepEqual(search("director:nolan,director:hamilton"), []);
});

test("quotes keep a comma inside a value out of the split", () => {
  assert.deepEqual(search('actor:"connery, sean"'), []);
  assert.deepEqual(search('actor:"connery|nolan north"'), [
    "Goldfinger",
    "The Witcher: Nightmare of the Wolf",
  ]);
});

test("a bare term is text, not a regex", () => {
  // Which is the point of only the field terms being regexes: a title typed
  // into the box with brackets or a dot in it is still a title.
  assert.deepEqual(search("the witcher: nightmare of the wolf"), [
    "The Witcher: Nightmare of the Wolf",
  ]);
  assert.deepEqual(search("t.e prestige"), []);
});

test("a prefix that is not a field name is part of the text", () => {
  // `re:zero` and `9:00` are things to search for, not fields to search in.
  assert.deepEqual(search("witcher: nightmare"), [
    "The Witcher: Nightmare of the Wolf",
  ]);
  assert.deepEqual(search("nosuchfield:nolan"), []);
});

test("a value that is not a valid regex is matched as text", () => {
  // Every query with a bracket in it is typed through this state, and an
  // uncaught SyntaxError here would empty the page mid-keystroke.
  assert.deepEqual(search("title:^the ("), []);
  assert.deepEqual(search("title:witcher("), []);
  assert.deepEqual(search('title:"the witcher: nightmare of the wolf"'), [
    "The Witcher: Nightmare of the Wolf",
  ]);
});

/** 400 rows of one long title, which is what the measurement in #228 used. */
const backtrackingRows = () =>
  Array.from({ length: 400 }, () => entry({ title: "a".repeat(40) }));

const millisecondsToSearch = (rows, query) => {
  const started = Date.now();
  const kept = filterEntries(rows, query, visibleFilmFields);
  return { elapsed: Date.now() - started, kept };
};

test("a pattern that would backtrack for minutes answers immediately", () => {
  // #228: `?q=` is compiled to a RegExp, so a link can carry one, and the
  // search runs on load rather than on a keypress — the tab was frozen before
  // the reader had done anything. `title:(a+)+$` measured 299 seconds over
  // these rows, and the repeated atom below does not finish at all, which is
  // why both are refused rather than merely timed: nothing can interrupt a
  // `RegExp.test` once it has started.
  const rows = backtrackingRows();

  for (const query of [
    "title:(a+)+$",
    "title:^(([a-z])+.)+[A-Z]$",
    `title:${"a*".repeat(12)}b`,
  ]) {
    const { elapsed, kept } = millisecondsToSearch(rows, query);
    assert.ok(elapsed < 1000, `${query} took ${elapsed}ms`);
    // Refused as a shape rather than abandoned on the clock, so this is a real
    // answer about titles that do not hold that text — not a giving up.
    assert.deepEqual(titlesOf(kept), []);
    assert.equal(wasAbandoned(kept), false);
  }
});

test("a refused shape is matched as text, the way one that will not compile is", () => {
  const rows = [
    entry({ title: "Twelve Monkeys" }),
    entry({ title: "Regex (a+)+ the Movie" }),
    entry({ title: "Nested (a*)* and (a|a)* Quantifiers" }),
    entry({ title: "Repeated a*a*b Atoms" }),
  ];
  const search = (query) => titlesOf(filterEntries(rows, query, visibleFilmFields));

  assert.deepEqual(search("title:(a+)+"), ["Regex (a+)+ the Movie"]);
  assert.deepEqual(search("title:(a*)*"), ["Nested (a*)* and (a|a)* Quantifiers"]);
  assert.deepEqual(search("title:(a|a)*"), ["Nested (a*)* and (a|a)* Quantifiers"]);
  assert.deepEqual(search("title:a*a*b"), ["Repeated a*a*b Atoms"]);
  assert.deepEqual(search("title:((a+))+"), []);
});

test("a pattern that cannot blow up is still a regex", () => {
  // What is refused is a quantifier on a group that repeats or alternates
  // inside it, and the same atom quantified twice in a row. A group that holds
  // text does neither, adjacent quantifiers on different atoms do neither, and
  // a bracket that was escaped into being one is not a group at all.
  const rows = [
    entry({ title: "The The Prestige" }),
    entry({ title: "Twelve Monkeys (1995)" }),
  ];
  const search = (query) => titlesOf(filterEntries(rows, query, visibleFilmFields));

  assert.deepEqual(search("title:(the )+prestige"), ["The The Prestige"]);
  assert.deepEqual(search("title:^t[a-z+ ]+ys"), ["Twelve Monkeys (1995)"]);
  assert.deepEqual(search("title:^t.*e M.*$"), ["Twelve Monkeys (1995)"]);
  assert.deepEqual(search("title:\\(1995\\)$"), ["Twelve Monkeys (1995)"]);
  assert.deepEqual(search("title:^(the|twelve) "), [
    "The The Prestige",
    "Twelve Monkeys (1995)",
  ]);
});

test("a pass that runs out of budget returns no rows, and says so", () => {
  // The budget is what covers the shapes the refusal misses, so this exercises
  // it without needing a pattern slow enough to be flaky: a row that is
  // expensive to *read* costs the pass the same time a slow pattern would.
  const slowRow = () => ({
    commonMetadata: {
      get englishTranslatedTitle() {
        const until = Date.now() + 5;
        while (Date.now() < until) {}
        return "Inception";
      },
    },
  });
  const rows = Array.from({ length: 400 }, slowRow);

  const started = Date.now();
  const kept = filterEntries(rows, "title:inception", visibleFilmFields);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
  assert.equal(kept.length, 0);
  // Not the rows matched so far, which would be a subset of the answer that
  // looks like the answer, and not all of them, which would be the search
  // quietly not happening.
  assert.equal(wasAbandoned(kept), true);
});

test("a pass that finishes is never marked as abandoned", () => {
  assert.equal(wasAbandoned(filterEntries(films, "nolan", visibleFilmFields)), false);
  assert.equal(wasAbandoned(filterEntries(films, "", visibleFilmFields)), false);
});

test("an empty field term keeps the rows that have the field at all", () => {
  assert.deepEqual(search("year:"), ["Inception", "Goldfinger", "The Prestige"]);
  assert.deepEqual(search("completed:"), ["Inception", "Goldfinger"]);
});

test("dates are matched as YYYY-MM-DD, not as the epoch milliseconds", () => {
  assert.deepEqual(search("completed:^2019"), ["Inception"]);
  assert.deepEqual(search("completed:2021-01-02"), ["Goldfinger"]);
  assert.deepEqual(search(`completed:${Date.UTC(2019, 5, 14)}`), []);
});

test("the title term matches the original title as well as the English one", () => {
  const akira = {
    commonMetadata: {
      englishTranslatedTitle: "Akira",
      originalTitle: "アキラ",
    },
  };
  assert.deepEqual(
    filterEntries([akira], "title:アキラ", visibleFilmFields),
    [akira]
  );
});

test("an empty query is every row, and the array it arrived in", () => {
  assert.equal(filterEntries(films, "", visibleFilmFields), films);
  assert.equal(filterEntries(films, "   ", visibleFilmFields), films);
  assert.equal(filterEntries(films, " , , ", visibleFilmFields), films);
});

test("a row missing the field it is searched on is dropped, not thrown over", () => {
  const bare = {};
  assert.deepEqual(filterEntries([bare], "director:nolan", visibleFilmFields), []);
  assert.deepEqual(filterEntries([bare], "nolan", visibleFilmFields), []);
});

test("every field name a column offers is spellable, and spelled one way", () => {
  // `fieldFor` is how a table turns its columns into the fields a bare term
  // is tried against, so a column whose field is not in the table searches
  // nothing at all — silently.
  const columnFields = [
    "commonMetadata.englishTranslatedTitle",
    "score",
    "commonMetadata.releaseYear",
    "commonMetadata.duration",
    "commonMetadata.directors",
    "commonMetadata.actors",
    "commonMetadata.studios",
    "commonMetadata.publishers",
    "commonMetadata.authors",
    "commonMetadata.platforms",
    "commonMetadata.genres",
    "progress",
    "startedDate",
    "completedDate",
  ];
  columnFields.forEach((columnField) =>
    assert.ok(fieldFor(columnField), `no search field for ${columnField}`)
  );

  const names = Object.values(searchFields).flatMap((field) => field.names);
  assert.deepEqual(
    names.filter((name, i) => names.indexOf(name) !== i),
    [],
    "two fields answer to the same name, so one of them is unreachable"
  );
});
