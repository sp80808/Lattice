import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTask } from "./index.js";

test("runTask records repository evidence before completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const result = await runTask("inspect this repository", { cwd });

  assert.equal(result.status, "completed");
  assert.equal(result.tap.task, "inspect this repository");
  assert.equal(result.tap.version, "0.1");
  assert.equal(result.tap.evidence[0]?.kind, "repository");
  assert.equal(result.tap.evidence[0]?.verified, true);

  const log = await readFile(result.eventLogPath, "utf8");
  const events = log.trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "tool.started",
      "tool.completed",
      "tap.created",
      "run.completed",
    ],
  );
});

test("runTask can attach explicit command verification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const result = await runTask("verify a deterministic command", {
    cwd,
    verifyCommand: {
      command: process.execPath,
      args: ["-e", "process.stdout.write('verified')"],
    },
  });

  assert.equal(result.tap.evidence.length, 2);
  assert.equal(result.tap.evidence[1]?.kind, "command");
  assert.match(result.tap.evidence[1]?.summary ?? "", /verified/);
  assert.equal(result.tap.verification.length, 1);
});

test("runTask records run.failed before rethrowing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const failing = {
    generate: async () => {
      throw new Error("generator offline");
    },
  };

  await assert.rejects(
    runTask("fail during search", {
      cwd,
      search: {
        generator: failing,
        decision: { decide: async () => { throw new Error("unused"); } },
        executor: { execute: async () => { throw new Error("unused"); } },
      },
    }),
    /generator offline/,
  );

  const [file] = await readdir(join(cwd, ".lattice", "runs"));
  const events = (await readFile(join(cwd, ".lattice", "runs", file!), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const last = events.at(-1);
  assert.equal(last.type, "run.failed");
  assert.match(last.payload.error, /generator offline/);
});

test("runTask reports each appended event to onEvent, ignoring listener errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const seen: string[] = [];
  const result = await runTask("observe events", {
    cwd,
    onEvent: (event) => {
      seen.push(event.type);
      if (event.type === "tap.created") throw new Error("listener bug");
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [
    "run.started",
    "tool.started",
    "tool.completed",
    "tap.created",
    "run.completed",
  ]);
});
