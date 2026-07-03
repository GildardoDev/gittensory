// Units for the EOL analyzer's version-pin parser (#2097). Kept separate so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractVersionPins } from "../dist/analyzers/eol-check.js";

function added(path: string, ...lines: string[]) {
  return { path, patch: ["@@ -1 +1," + lines.length + " @@", ...lines.map((l) => "+" + l)].join("\n") };
}

test("extractVersionPins reads a Dockerfile FROM tag into (product, leading-version)", () => {
  const pins = extractVersionPins([added("Dockerfile", "FROM python:3.8-slim")]);
  assert.deepEqual(pins, [{ file: "Dockerfile", product: "python", version: "3.8" }]);
});

test("extractVersionPins maps the node image to nodejs and drops an unknown product", () => {
  const pins = extractVersionPins([added("Dockerfile", "FROM node:18.17.0", "FROM mystery:1.2.3")]);
  assert.deepEqual(pins, [{ file: "Dockerfile", product: "nodejs", version: "18.17.0" }]);
});

test("extractVersionPins reads .nvmrc and go.mod pins", () => {
  assert.deepEqual(extractVersionPins([added(".nvmrc", "18.17.0")]), [{ file: ".nvmrc", product: "nodejs", version: "18.17.0" }]);
  assert.deepEqual(extractVersionPins([added("go.mod", "go 1.21")]), [{ file: "go.mod", product: "go", version: "1.21" }]);
});

test("extractVersionPins ignores removed/context lines and files with no patch", () => {
  const patch = ["@@ -1 +1,2 @@", "-FROM python:3.7", " FROM python:3.9"].join("\n");
  assert.deepEqual(extractVersionPins([{ path: "Dockerfile", patch }]), []);
  assert.deepEqual(extractVersionPins([{ path: "Dockerfile" }]), []);
});
