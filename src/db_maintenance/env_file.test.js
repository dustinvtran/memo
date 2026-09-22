const { test } = require("node:test");
const assert = require("node:assert/strict");

const { chooseEnvFile } = require("./env_file");

const CANDIDATES = ["/repo/src/db_maintenance/.env", "/repo/.env"];

/** `exists` as a set membership test, so a case reads as a list of files. */
const present = (...paths) => (path) => paths.includes(path);

test("the folder's own .env is preferred when it is there", () => {
  assert.equal(
    chooseEnvFile({ candidates: CANDIDATES, exists: present(...CANDIDATES) }),
    "/repo/src/db_maintenance/.env"
  );
});

test("the repository root is used when the folder has none", () => {
  assert.equal(
    chooseEnvFile({ candidates: CANDIDATES, exists: present("/repo/.env") }),
    "/repo/.env"
  );
});

test("with neither present the first candidate is reported, not undefined", () => {
  assert.equal(
    chooseEnvFile({ candidates: CANDIDATES, exists: present() }),
    "/repo/src/db_maintenance/.env"
  );
});

test("MEMO_ENV_FILE beats both, including when nothing else exists", () => {
  assert.equal(
    chooseEnvFile({
      override: "/elsewhere/.env",
      candidates: CANDIDATES,
      exists: present(...CANDIDATES),
    }),
    "/elsewhere/.env"
  );
});

test("an override pointing at nothing is honoured rather than fallen back from", () => {
  // Falling back here would read a different set of credentials than the
  // caller named, which on this project means production's by accident.
  assert.equal(
    chooseEnvFile({
      override: "/elsewhere/.env",
      candidates: CANDIDATES,
      exists: present("/repo/.env"),
    }),
    "/elsewhere/.env"
  );
});
