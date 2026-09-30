import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LatticeApiError, LatticeClient } from "@lattice/sdk";
import { createAutoModeFixture } from "@lattice/service/testing";
import { startLatticeServer } from "./index.js";

async function withServer(
  options: Parameters<typeof startLatticeServer>[0],
  body: (url: string, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-server-"));
  const started = await startLatticeServer({ cwd, port: 0, ...options });
  try {
    await body(started.url, cwd);
  } finally {
    await started.close();
  }
}

function rawRequest(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("SDK round-trips tasks, runs, events, decisions, stats and doctor", async () => {
  await withServer({}, async (url, cwd) => {
    const client = new LatticeClient({ baseUrl: url });
    assert.equal((await client.waitUntilReady()).service, "lattice");

    const run = await client.runTask("inspect via sdk");
    assert.equal(run.mode, "observe");
    assert.equal(run.runtimeMode, "evidence-only");
    assert.equal(run.tap.task, "inspect via sdk");

    const runs = await client.listRuns({ limit: 5 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.runId, run.runId);

    const detail = await client.getRun("latest");
    assert.equal(detail.runId, run.runId);
    assert.equal(detail.status, "completed");
    assert.equal(detail.cwd, cwd);

    const events = await client.getEvents(run.runId.slice(0, 8));
    assert.equal(events[0]?.type, "run.started");

    const decision = await client.decide({
      question: "Which experiment first?",
      choices: [
        { id: "a", label: "Run tests" },
        { id: "b", label: "Read logs" },
      ],
      provider: "random",
    });
    assert.equal(decision.identity.provider, "random");

    const stats = await client.stats();
    assert.equal(typeof stats, "object");

    const doctor = await client.doctor({ network: false });
    assert.equal(doctor.cwd, cwd);
  });
});

test("API errors surface as typed LatticeApiError", async () => {
  await withServer({}, async (url) => {
    const client = new LatticeClient({ baseUrl: url });
    await assert.rejects(client.runTask("  "), (error: unknown) => {
      assert.ok(error instanceof LatticeApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_request");
      return true;
    });
    await assert.rejects(client.getRun("deadbeef"), (error: unknown) =>
      error instanceof LatticeApiError && error.status === 404,
    );
    await assert.rejects(
      client.decide({ question: "q", choices: [{ id: "a", label: "A" }] }),
      (error: unknown) =>
        error instanceof LatticeApiError && error.code === "config_error",
    );
  });
});

test("daemon refuses cross-site, rebinding and non-JSON requests", async () => {
  await withServer({}, async (url) => {
    const text = await fetch(`${url}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ task: "csrf" }),
    });
    assert.equal(text.status, 415);

    const cross = await fetch(`${url}/v1/tasks`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(cross.status, 403);

    assert.equal(await rawRequest(`${url}/health`, { host: "evil.example:4774" }), 403);
    assert.equal(await rawRequest(`${url}/health`, { host: "localhost:4774" }), 200);

    assert.equal((await fetch(`${url}/v1/nope`)).status, 404);
    assert.equal((await fetch(`${url}/v1/stats`, { method: "POST" })).status, 405);
  });
});

test("optional bearer token protects everything except health", async () => {
  await withServer({ token: "s3cret" }, async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/v1/tasks`)).status, 401);
    const authed = new LatticeClient({ baseUrl: url, token: "s3cret" });
    assert.deepEqual(await authed.listRuns(), []);
    const wrong = new LatticeClient({ baseUrl: url, token: "nope!!" });
    await assert.rejects(wrong.listRuns(), (error: unknown) =>
      error instanceof LatticeApiError && error.status === 401,
    );
  });
});

async function slowObserveConfig(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".lattice"), { recursive: true });
  await writeFile(
    join(cwd, ".lattice", "config.json"),
    JSON.stringify({
      mode: "observe",
      verify: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('slow ok'), 400)"],
      },
    }),
  );
}

test("submitTask returns 202 immediately and events stream until completion", async () => {
  await withServer({}, async (url, cwd) => {
    await slowObserveConfig(cwd);
    const client = new LatticeClient({ baseUrl: url });

    const accepted = await client.submitTask("slow async task");
    assert.equal(accepted.status, "running");
    assert.equal(accepted.mode, "observe");
    assert.equal(accepted.links.events, `/v1/events/${accepted.runId}?follow=true`);
    assert.equal((await client.health()).activeRuns, 1);
    assert.equal((await client.getRun(accepted.runId)).status, "incomplete");

    const types: string[] = [];
    for await (const event of client.streamEvents(accepted.runId)) types.push(event.type);
    assert.equal(types[0], "run.started");
    assert.equal(types.at(-1), "run.completed");

    const resumed: number[] = [];
    for await (const event of client.streamEvents(accepted.runId, { after: 5 })) resumed.push(event.seq);
    assert.equal(resumed[0], 6);

    const detail = await client.waitForRun("latest");
    assert.equal(detail.status, "completed");
    assert.match(detail.tap?.evidence[1]?.summary ?? "", /slow ok/);
  });
});

test("async submission still rejects bad input up front; unknown streams are 404", async () => {
  await withServer({}, async (url) => {
    const client = new LatticeClient({ baseUrl: url });
    await assert.rejects(client.submitTask(" "), (error: unknown) =>
      error instanceof LatticeApiError && error.status === 400,
    );
    await assert.rejects(
      (async () => {
        for await (const _event of client.streamEvents("deadbeef")) {
          // unreachable
        }
      })(),
      (error: unknown) => error instanceof LatticeApiError && error.status === 404,
    );
    const raw = await fetch(`${url}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "x", wait: "no" }),
    });
    assert.equal(raw.status, 400);
  });
});

test("closing an SSE stream early does not break the server", async () => {
  await withServer({}, async (url, cwd) => {
    await slowObserveConfig(cwd);
    const client = new LatticeClient({ baseUrl: url });
    const accepted = await client.submitTask("abandon stream");
    const controller = new AbortController();
    const seen: string[] = [];
    await assert.rejects(async () => {
      for await (const event of client.streamEvents(accepted.runId, { signal: controller.signal })) {
        seen.push(event.type);
        controller.abort();
      }
    });
    assert.equal(seen[0], "run.started");
    assert.equal((await client.waitForRun(accepted.runId)).status, "completed");
  });
});

test("remote review: a client answers a manual-mode decision and the run is solved by tests", async () => {
  const { cwd, closeModel } = await createAutoModeFixture();
  try {
    await withServer({ cwd }, async (url) => {
      const client = new LatticeClient({ baseUrl: url });
      const accepted = await client.submitTask("fix the add test", {
        mode: "configured",
        review: "remote",
      });

      let pending = await client.waitForReview(accepted.runId, { timeoutMs: 20_000 });
      assert.equal(pending.round, 1);
      assert.deepEqual(pending.modelSelection, ["inspect"]);
      assert.deepEqual((await client.listReviews()).map((r) => r.runId), [accepted.runId]);

      await assert.rejects(
        client.answerReview(accepted.runId, { action: "approve", reviewId: "stale:r9" }),
        (error: unknown) => error instanceof LatticeApiError && error.status === 409,
      );
      const answered = await client.answerReview(accepted.runId, {
        action: "replace",
        selected: ["fix-add"],
        note: "patching is the cheapest discriminating experiment",
        reviewId: pending.reviewId,
      });
      assert.equal(answered.accepted, true);

      const detail = await client.waitForRun(accepted.runId);
      assert.equal(detail.status, "completed");
      assert.match(detail.summary ?? "", /search solved after 1 round/);
      assert.ok(detail.tap?.evidence.some((e) => e.kind === "command" && e.verified && /exit=0/.test(e.summary)));
      assert.deepEqual(await client.listReviews(), []);
    });
  } finally {
    await closeModel();
  }
});

test("without remote review, a manual-mode decision blocks instead of auto-approving", async () => {
  const { cwd, closeModel } = await createAutoModeFixture();
  try {
    await withServer({ cwd }, async (url) => {
      const client = new LatticeClient({ baseUrl: url });
      const run = await client.runTask("fix the add test", { mode: "configured" });
      assert.match(run.summary, /search blocked/);
      assert.ok(run.tap.uncertainties.some((u) => /no reviewer is available/.test(u)));
    });
  } finally {
    await closeModel();
  }
});
