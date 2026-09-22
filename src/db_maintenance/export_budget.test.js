const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  WARN_FRACTION,
  summarizeExportSizes,
  describeReport,
  toSummary,
  withThousands,
  formatPercent,
} = require("./export_budget");

/** The constant `src/api/controllers/export.js` enforces, five mebibytes. */
const CEILING = 5 * 1024 * 1024;

const measurement = (overrides = {}) => ({
  username: "nil",
  url: "/api/export/nil?limit=99999",
  format: "json",
  entries: 1589,
  status: 200,
  bytes: 4741315,
  ...overrides,
});

const report = (measurements) =>
  summarizeExportSizes({ ceiling: CEILING, measurements });

test("the body #422 measured is 90.4% of the ceiling, not 94.8%", () => {
  // The issue divided 4,741,315 by five million; the constant is five
  // mebibytes. Both readings are of the same body and only one is of the
  // number the endpoint enforces — which is the reason this is computed.
  const [row] = report([measurement()]).rows;

  assert.equal(formatPercent(row.percent), "90.4%");
  assert.equal(row.headroomBytes, 501565);
  assert.equal(row.level, "approaching");
});

test("the headroom is reported in entries as well as in bytes", () => {
  const [row] = report([measurement({ bytes: 4741315, entries: 1589 })]).rows;

  // 4,741,315 over 1,589 entries is 2,984 bytes each, and 501,565 bytes of
  // headroom is 168 more of them.
  assert.equal(Math.round(row.bytesPerEntry), 2984);
  assert.equal(row.entriesOfHeadroom, 168);
});

test("a body under the threshold is unremarkable", () => {
  const { level, counts } = report([
    measurement({ bytes: Math.floor(CEILING * WARN_FRACTION) - 1 }),
  ]);

  assert.equal(level, "ok");
  assert.equal(counts.ok, 1);
  assert.equal(counts.approaching, 0);
});

test("a body of exactly the ceiling is approaching it, not over it", () => {
  // `withinBudget` sends a body of `<= MAX_BODY_BYTES`, so the ceiling itself
  // is the last size that still works.
  const [row] = report([measurement({ bytes: CEILING })]).rows;

  assert.equal(row.level, "approaching");
  assert.equal(row.headroomBytes, 0);
  assert.equal(row.entriesOfHeadroom, 0);
});

test("a refused body is over the ceiling and claims no percentage", () => {
  // The 413 carries advice rather than the list, so there is nothing to
  // weigh: the finding is that the line has been crossed.
  const [row] = report([
    measurement({ status: 413, bytes: undefined }),
  ]).rows;

  assert.equal(row.level, "over");
  assert.equal(row.refused, true);
  assert.equal(row.percent, undefined);
  assert.equal(row.headroomBytes, undefined);
  assert.equal(row.entriesOfHeadroom, undefined);
});

test("a response that is neither a body nor a refusal is unmeasured", () => {
  const unmeasured = report([measurement({ status: 502, bytes: undefined })]);

  assert.equal(unmeasured.counts.unknown, 1);
  // Not folded into the finding: nothing was weighed, so nothing is over.
  assert.equal(unmeasured.level, "ok");
  assert.equal(unmeasured.worst, undefined);
  assert.match(describeReport(unmeasured), /No export body could be measured/);
  assert.match(describeReport(unmeasured), /1 body could not be measured/);
});

test("the worst body leads, and a refusal leads over any measured one", () => {
  const { rows, worst } = report([
    measurement({ url: "/api/export/books/nil", bytes: 439686 }),
    measurement({ url: "/api/export/games/nil", bytes: 2956687 }),
    measurement({ url: "/api/export/nil?limit=99999", status: 413, bytes: undefined }),
  ]);

  assert.deepEqual(
    [...rows.map((row) => row.url)],
    [
      "/api/export/nil?limit=99999",
      "/api/export/games/nil",
      "/api/export/books/nil",
    ]
  );
  assert.equal(worst.url, "/api/export/nil?limit=99999");
});

test("an entry count of zero divides nothing", () => {
  const [row] = report([measurement({ bytes: 412, entries: 0 })]).rows;

  assert.equal(row.bytesPerEntry, undefined);
  assert.equal(row.entriesOfHeadroom, undefined);
  assert.equal(row.level, "ok");
});

test("a ceiling that is not a size is refused rather than divided by", () => {
  const { blocked, rows } = summarizeExportSizes({
    ceiling: 0,
    measurements: [measurement()],
  });

  assert.match(blocked, /positive number of bytes/);
  assert.deepEqual([...rows], []);
});

test("the headline names the count, the threshold and the largest body", () => {
  const sentence = describeReport(
    report([
      measurement(),
      measurement({ url: "/api/export/tv/nil", bytes: 324456, entries: 510 }),
    ])
  );

  assert.match(sentence, /1 of 2 export bodies is at or past 80.0% of the/);
  assert.match(sentence, /5,242,880-byte ceiling/);
  assert.match(sentence, /\/api\/export\/nil\?limit=99999 \(json\) at 90\.4%/);
  assert.match(sentence, /501,565 to spare/);
});

test("the summary is the headline and a row for every body", () => {
  const text = toSummary(
    report([
      measurement(),
      measurement({ url: "/api/export/tv/nil", bytes: 324456, entries: 510 }),
    ])
  );
  const lines = text.split("\n");

  assert.match(lines[0], /^1 of 2 export bodies/);
  assert.match(text, /level\s+share\s+bytes\s+entries\s+headroom\s+more/);
  assert.match(text, /APPROACHING\s+90\.4%\s+4,741,315\s+1,589\s+501,565/);
  assert.match(text, /ok\s+6\.2%\s+324,456/);
  // One heading row plus one row per body, under the headline and its blank.
  assert.equal(lines.length, 5);
});

test("nothing measured says so rather than printing an empty table", () => {
  assert.equal(toSummary(report([])), "No export bodies were measured.");
});

test("thousands are grouped the same way in every locale", () => {
  assert.equal(withThousands(4741315), "4,741,315");
  assert.equal(withThousands(999), "999");
  assert.equal(withThousands(-501565), "-501,565");
  assert.equal(withThousands(2984.7), "2,984");
});
