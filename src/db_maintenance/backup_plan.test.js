const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  snapshotDirName,
  parseSnapshotDate,
  planPruning,
} = require("./backup_plan");

const NOW = new Date("2024-06-30T12:00:00.000Z");

const nameFor = (iso) => snapshotDirName(new Date(iso));

test("a snapshot name round-trips through the parser", () => {
  const date = new Date("2024-06-30T12:34:56.789Z");
  assert.equal(snapshotDirName(date), "snapshot-2024-06-30T12-34-56-789Z");
  assert.deepEqual(parseSnapshotDate(snapshotDirName(date)), date);
});

test("snapshot names sort chronologically as plain strings", () => {
  const names = [
    nameFor("2024-06-30T12:00:00.000Z"),
    nameFor("2024-01-02T03:04:05.006Z"),
    nameFor("2024-06-30T09:00:00.000Z"),
  ];

  assert.deepEqual([...names].sort(), [names[1], names[2], names[0]]);
});

test("anything that isn't one of our snapshot names is not a snapshot", () => {
  assert.equal(parseSnapshotDate("backups"), undefined);
  assert.equal(parseSnapshotDate("snapshot-yesterday"), undefined);
  assert.equal(parseSnapshotDate("snapshot-2024-13-45T99-99-99-999Z"), undefined);
  assert.equal(parseSnapshotDate("2024-06-30T12-00-00-000Z"), undefined);
});

test("directories we don't recognise are reported, never removed", () => {
  const plan = planPruning(["backups", "notes.txt"], {}, NOW);

  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.unrecognised, ["backups", "notes.txt"]);
});

test("everything inside the daily window is kept", () => {
  const names = [
    nameFor("2024-06-30T00:00:00.000Z"),
    nameFor("2024-06-29T00:00:00.000Z"),
    nameFor("2024-06-28T00:00:00.000Z"),
  ];

  const plan = planPruning(names, { days: 14, weeks: 0, months: 0 }, NOW);

  assert.deepEqual(plan.keep, names);
  assert.deepEqual(plan.remove, []);
});

test("outside the daily window, one snapshot per week survives", () => {
  const names = [
    // Week of 2024-05-06, three snapshots, the newest one wins.
    nameFor("2024-05-06T00:00:00.000Z"),
    nameFor("2024-05-08T00:00:00.000Z"),
    nameFor("2024-05-10T00:00:00.000Z"),
    // Week of 2024-05-13.
    nameFor("2024-05-14T00:00:00.000Z"),
  ];

  const plan = planPruning(names, { days: 1, weeks: 8, months: 0 }, NOW);

  assert.deepEqual(plan.keep.sort(), [
    nameFor("2024-05-10T00:00:00.000Z"),
    nameFor("2024-05-14T00:00:00.000Z"),
  ]);
  assert.deepEqual(plan.remove.sort(), [
    nameFor("2024-05-06T00:00:00.000Z"),
    nameFor("2024-05-08T00:00:00.000Z"),
  ]);
});

test("a Sunday belongs to the week that started the Monday before", () => {
  const names = [
    nameFor("2024-05-12T23:00:00.000Z"), // Sunday
    nameFor("2024-05-06T00:00:00.000Z"), // the Monday of that same week
  ];

  const plan = planPruning(names, { days: 1, weeks: 1, months: 0 }, NOW);

  assert.deepEqual(plan.keep, [nameFor("2024-05-12T23:00:00.000Z")]);
  assert.deepEqual(plan.remove, [nameFor("2024-05-06T00:00:00.000Z")]);
});

test("past the weekly window, one snapshot per month survives", () => {
  const names = [
    nameFor("2023-08-04T00:00:00.000Z"),
    nameFor("2023-08-19T00:00:00.000Z"),
    nameFor("2023-09-19T00:00:00.000Z"),
  ];

  const plan = planPruning(names, { days: 1, weeks: 0, months: 12 }, NOW);

  assert.deepEqual(plan.keep.sort(), [
    nameFor("2023-08-19T00:00:00.000Z"),
    nameFor("2023-09-19T00:00:00.000Z"),
  ]);
  assert.deepEqual(plan.remove, [nameFor("2023-08-04T00:00:00.000Z")]);
});

test("an old snapshot survives as the newest one of its week and month", () => {
  const names = [
    nameFor("2024-06-30T00:00:00.000Z"),
    // Same week, and same month, as each other.
    nameFor("2020-01-01T00:00:00.000Z"),
    nameFor("2020-01-02T00:00:00.000Z"),
  ];

  const plan = planPruning(names, { days: 14, weeks: 8, months: 12 }, NOW);

  assert.deepEqual(plan.keep, [
    nameFor("2024-06-30T00:00:00.000Z"),
    nameFor("2020-01-02T00:00:00.000Z"),
  ]);
  assert.deepEqual(plan.remove, [nameFor("2020-01-01T00:00:00.000Z")]);
});

test("an old snapshot goes once newer weeks have spent the weekly budget", () => {
  const names = [
    nameFor("2024-06-24T00:00:00.000Z"),
    nameFor("2024-06-10T00:00:00.000Z"),
  ];

  const plan = planPruning(names, { days: 1, weeks: 1, months: 0 }, NOW);

  assert.deepEqual(plan.keep, [nameFor("2024-06-24T00:00:00.000Z")]);
  assert.deepEqual(plan.remove, [nameFor("2024-06-10T00:00:00.000Z")]);
});

test("the newest snapshot survives a policy that keeps nothing", () => {
  const names = [
    nameFor("2020-01-01T00:00:00.000Z"),
    nameFor("2020-01-02T00:00:00.000Z"),
  ];

  const plan = planPruning(names, { days: 0, weeks: 0, months: 0 }, NOW);

  assert.deepEqual(plan.keep, [nameFor("2020-01-02T00:00:00.000Z")]);
  assert.deepEqual(plan.remove, [nameFor("2020-01-01T00:00:00.000Z")]);
});

test("a missing week doesn't use up the weekly budget", () => {
  const names = [
    nameFor("2024-06-24T00:00:00.000Z"),
    // no snapshot in the week of 2024-06-17
    nameFor("2024-06-10T00:00:00.000Z"),
  ];

  const plan = planPruning(names, { days: 1, weeks: 2, months: 0 }, NOW);

  assert.deepEqual(plan.remove, []);
});
