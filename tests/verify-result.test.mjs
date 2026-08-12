import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exitCodeForVerifyResults } from "../scripts/verify-result.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("verify gate returns success only when every leg passes", () => {
  assert.equal(exitCodeForVerifyResults([{ status: "pass" }, { status: "pass" }]), 0);
});

test("verify gate returns incomplete when any leg is unverified", () => {
  assert.equal(exitCodeForVerifyResults([{ status: "pass" }, { status: "skipped" }]), 2);
});

test("verify gate failure takes precedence over an unverified leg", () => {
  assert.equal(exitCodeForVerifyResults([{ status: "fail" }, { status: "skipped" }]), 1);
  assert.equal(exitCodeForVerifyResults([{ status: "error" }, { status: "skipped" }]), 1);
});

test("the deliberate no-Linux entrypoint passes --no-linux to the verifier", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["verify:no-linux"], "node scripts/verify.mjs --no-linux");
});
