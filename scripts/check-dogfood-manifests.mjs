#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dogfood");
const sha = /^[0-9a-f]{40}$/;
const required = [
  "schema",
  "id",
  "version",
  "task_class",
  "repository",
  "base_sha",
  "task_statement",
  "allowed_tools",
  "acceptance",
  "reference",
  "leakage_guard",
  "provenance",
];

const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
if (index.schema !== "lattice.dogfood.corpus/v0") {
  throw new Error(`bad corpus schema: ${index.schema}`);
}
if (index.cases.length !== 3) {
  throw new Error(`expected 3 seed cases, found ${index.cases.length}`);
}

const classes = new Set();
for (const rel of index.cases) {
  const doc = JSON.parse(await readFile(join(root, rel), "utf8"));
  for (const key of required) {
    if (!(key in doc)) throw new Error(`${rel} missing ${key}`);
  }
  if (doc.schema !== "lattice.dogfood.case/v0") {
    throw new Error(`${rel} bad schema`);
  }
  if (!sha.test(doc.base_sha)) throw new Error(`${rel} bad base_sha`);
  if (!sha.test(doc.reference.gold_fix_sha)) throw new Error(`${rel} bad gold_fix_sha`);
  if (doc.task_statement.toLowerCase().includes(doc.reference.gold_fix_sha)) {
    throw new Error(`${rel} task_statement leaks gold_fix_sha`);
  }
  if (!doc.leakage_guard.forbid_future_files) {
    throw new Error(`${rel} must forbid_future_files`);
  }
  if (!doc.leakage_guard.exclude_commits_from_context.includes(doc.reference.gold_fix_sha)) {
    throw new Error(`${rel} gold_fix_sha must be excluded from context`);
  }
  if (!doc.acceptance.must_fail_on_broken_base) {
    throw new Error(`${rel} must_fail_on_broken_base required`);
  }
  classes.add(doc.task_class);
}

for (const need of [
  "verification-integrity",
  "semantic-multi-structure",
  "performance-semantic-preservation",
]) {
  if (!classes.has(need)) throw new Error(`missing task class ${need}`);
}

const caseFiles = (await readdir(join(root, "cases"))).filter((f) => f.endsWith(".json"));
if (caseFiles.length !== index.cases.length) {
  throw new Error("index cases and cases/ directory length mismatch");
}

console.log(`dogfood manifests ok: ${index.cases.length} seeds, classes=${[...classes].join(",")}`);
