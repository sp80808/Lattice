import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import type { RunLease } from "@lattice/protocol";
import { leaseLiveness, runLeasePath, runTask } from "./index.js";

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

test("a run holds a lease from run.started until it ends", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  let leaseAtStart: RunLease | undefined;
  let leasePath = "";
  const result = await runTask("leased", {
    cwd,
    onEvent: (event) => {
      if (event.type !== "run.started") return;
      leasePath = runLeasePath(join(cwd, ".lattice", "runs"), event.runId);
      leaseAtStart = JSON.parse(readFileSync(leasePath, "utf8")) as RunLease;
    },
  });
  assert.equal(leaseAtStart?.pid, process.pid);
  assert.equal(leaseAtStart?.runId, result.runId);
  assert.equal(leaseLiveness(leaseAtStart), "running");
  assert.equal(existsSync(leasePath), false, "lease outlived a completed run");

  await assert.rejects(
    runTask("fails", {
      cwd,
      verifyCommand: { command: join(cwd, "does-not-exist") },
    }),
  );
  const leftovers = (await readdir(join(cwd, ".lattice", "runs"))).filter((name) =>
    name.endsWith(".lease.json"),
  );
  assert.deepEqual(leftovers, [], "lease outlived a failed run");
});

test("leaseLiveness trusts only fresh leases held by a live process", () => {
  const now = Date.parse("2026-10-08T00:00:30Z");
  const lease: RunLease = {
    schema: "lattice.run-lease/v1",
    runId: "r",
    pid: process.pid,
    host: "here",
    acquiredAt: "2026-10-08T00:00:00Z",
    heartbeatAt: "2026-10-08T00:00:20Z",
    ttlMs: 30_000,
  };
  assert.equal(leaseLiveness(lease, now, "here"), "running");
  assert.equal(leaseLiveness({ ...lease, heartbeatAt: "2026-10-07T23:59:00Z" }, now, "here"), "interrupted");
  // A pid that cannot exist on this host ends the lease at once.
  assert.equal(leaseLiveness({ ...lease, pid: 2 ** 22 + 7 }, now, "here"), "interrupted");
  // On another host only expiry can end it.
  assert.equal(leaseLiveness({ ...lease, pid: 2 ** 22 + 7 }, now, "elsewhere"), "running");
  assert.equal(leaseLiveness(undefined, now, "here"), "interrupted");
});
