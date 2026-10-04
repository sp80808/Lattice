#!/usr/bin/env node
// Run node:test files and fail on anything that did not actually pass.
//
//   node scripts/run-node-tests.mjs <test files...>
//
// `node --test` exits 0 when tests are skipped or marked todo, so a suite can
// go quietly hollow. This runner treats failed, cancelled, skipped and todo
// tests as failures, and also fails a file that reports no tests at all.
// A skip or todo that is genuinely intended goes in scripts/test-allowlist.json
// with a reason; entries that no longer match anything are reported as stale.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const root = resolve(import.meta.dirname, "..");
const files = process.argv.slice(2).map((file) => resolve(file));
if (files.length === 0) {
  console.error("usage: node scripts/run-node-tests.mjs <test files...>");
  process.exit(2);
}

const allowlistPath = process.env.LATTICE_TEST_ALLOWLIST ?? resolve(root, "scripts/test-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
for (const entry of allowlist) {
  if (!entry.file || !entry.test || !entry.reason?.trim()) {
    console.error(`${allowlistPath}: every entry needs "file", "test" and a non-empty "reason"`);
    process.exit(2);
  }
}
const used = new Set();

const problems = [];
const testsPerFile = new Map(files.map((file) => [file, 0]));
const rel = (file) => (file ? relative(root, file) : "<unknown file>");

function allowed(file, name) {
  const index = allowlist.findIndex((entry) => resolve(root, entry.file) === file && entry.test === name);
  if (index === -1) return false;
  used.add(index);
  return true;
}

const stream = run({ files });

// A file that declares no tests is reported as one passing test named after
// the file itself, so that event must not count as a test.
const isFileWrapper = (data) => data.name === data.file;

stream.on("test:pass", (data) => {
  if (data.details?.type !== "suite" && !isFileWrapper(data) && testsPerFile.has(data.file)) {
    testsPerFile.set(data.file, testsPerFile.get(data.file) + 1);
  }
  const kind = data.skip !== undefined ? "skipped" : data.todo !== undefined ? "todo" : undefined;
  if (kind && !allowed(data.file, data.name)) {
    problems.push(`${kind}: ${rel(data.file)} › ${data.name} (not in scripts/test-allowlist.json)`);
  }
});

stream.on("test:fail", (data) => {
  if (testsPerFile.has(data.file)) testsPerFile.set(data.file, testsPerFile.get(data.file) + 1);
  const failureType = data.details?.error?.failureType;
  const kind = failureType === "cancelledByParent" ? "cancelled" : "failed";
  // A failing subtest also fails its parent; report the leaf only once.
  if (failureType === "subtestsFailed") return;
  problems.push(`${kind}: ${rel(data.file)} › ${data.name}`);
});

stream.compose(spec).pipe(process.stdout);

stream.on("end", () => {
  for (const [file, count] of testsPerFile) {
    if (count === 0) problems.push(`empty: ${rel(file)} reported no tests`);
  }
  allowlist.forEach((entry, index) => {
    if (!used.has(index)) problems.push(`stale allow-list entry: ${entry.file} › ${entry.test}`);
  });
  if (problems.length > 0) {
    process.exitCode = 1;
    console.error(`\n${problems.length} test integrity problem(s):`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
  }
});
