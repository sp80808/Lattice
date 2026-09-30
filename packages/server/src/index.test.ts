import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LatticeApiError, LatticeClient } from "@lattice/sdk";
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
