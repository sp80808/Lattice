import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createAutoModeFixture } from "@lattice/service/testing";
import { createMcpHandler, serveMcpStdio, type JsonRpcResponse } from "./index.js";

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });

function text(response: JsonRpcResponse | undefined): string {
  const result = response?.result as { content: Array<{ text: string }> };
  return result.content[0]!.text;
}

test("initialize negotiates protocol version and lists tools", async () => {
  const handle = createMcpHandler({ cwd: tmpdir() });
  const init = await handle(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} }));
  assert.equal((init?.result as { protocolVersion: string }).protocolVersion, "2025-03-26");

  const future = await handle(rpc(2, "initialize", { protocolVersion: "2099-01-01" }));
  assert.equal((future?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");

  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);

  const list = await handle(rpc(3, "tools/list"));
  const names = (list?.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools.map((t) => t.name);
  assert.deepEqual(names, [
    "lattice_run",
    "lattice_runs",
    "lattice_show_run",
    "lattice_reviews",
    "lattice_review",
    "lattice_decide",
    "lattice_stats",
    "lattice_doctor",
  ]);

  assert.equal((await handle(rpc(4, "nope")))?.error?.code, -32601);
  assert.equal((await handle(rpc(5, "tools/call", { name: "missing" })))?.error?.code, -32602);
});

test("tools run tasks, show runs and report tool errors as results", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-mcp-"));
  const handle = createMcpHandler({ cwd });

  const run = await handle(rpc(1, "tools/call", { name: "lattice_run", arguments: { task: "inspect via mcp" } }));
  const payload = JSON.parse(text(run));
  assert.equal(payload.mode, "observe");
  assert.equal(payload.evidence[0].kind, "repository");

  const shown = JSON.parse(text(await handle(rpc(2, "tools/call", { name: "lattice_show_run", arguments: { id: "latest" } }))));
  assert.equal(shown.runId, payload.runId);
  assert.equal(shown.tap.task, "inspect via mcp");

  const runs = JSON.parse(text(await handle(rpc(3, "tools/call", { name: "lattice_runs", arguments: {} }))));
  assert.equal(runs.runs.length, 1);

  const bad = await handle(rpc(4, "tools/call", { name: "lattice_run", arguments: { task: "" } }));
  assert.equal((bad?.result as { isError?: boolean }).isError, true);
  assert.match(text(bad), /invalid_request/);

  const noModel = await handle(
    rpc(5, "tools/call", {
      name: "lattice_decide",
      arguments: { question: "q", choices: [{ id: "a", label: "A" }] },
    }),
  );
  assert.match(text(noModel), /config_error/);
});

test("stdio transport frames one JSON message per line", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  const done = serveMcpStdio({ cwd: tmpdir(), input, output });

  input.write(JSON.stringify(rpc(1, "ping")) + "\n");
  input.write("{not json\n");
  input.end(JSON.stringify(rpc(2, "tools/list")) + "\n");
  await done;

  const lines = written.trim().split("\n").map((line: string) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.ok(lines.some((m: JsonRpcResponse) => m.id === 1 && m.result));
  assert.ok(lines.some((m: JsonRpcResponse) => m.id === null && m.error?.code === -32700));
  assert.ok(lines.some((m: JsonRpcResponse) => m.id === 2 && m.result));
});

test("lattice_run with wait=false returns a runId before the run finishes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-mcp-async-"));
  await mkdir(join(cwd, ".lattice"));
  await writeFile(
    join(cwd, ".lattice", "config.json"),
    JSON.stringify({
      mode: "observe",
      verify: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 300)"] },
    }),
  );
  const handle = createMcpHandler({ cwd });
  const started = JSON.parse(
    text(await handle(rpc(1, "tools/call", { name: "lattice_run", arguments: { task: "async", wait: false } }))),
  );
  assert.equal(started.status, "running");

  const show = async () =>
    JSON.parse(text(await handle(rpc(2, "tools/call", { name: "lattice_show_run", arguments: { id: started.runId } }))));
  assert.equal((await show()).status, "incomplete");
  let status = "incomplete";
  for (let attempt = 0; attempt < 50 && status === "incomplete"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = (await show()).status;
  }
  assert.equal(status, "completed");
});

test("an MCP client can act as Lattice's reviewer", async () => {
  const { cwd, closeModel } = await createAutoModeFixture();
  try {
    const handle = createMcpHandler({ cwd });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await handle(rpc(1, "tools/call", { name, arguments: args }));
      const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: result.isError, text: result.content[0]!.text };
    };

    const started = JSON.parse(
      (await call("lattice_run", { task: "fix the add test", mode: "configured", review: "remote", wait: false })).text,
    );
    assert.match(started.next, /lattice_review/);

    let pending: { runId: string; reviewId: string; modelSelection: string[] } | undefined;
    for (let attempt = 0; attempt < 200 && !pending; attempt++) {
      pending = JSON.parse((await call("lattice_reviews", {})).text).reviews[0];
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(pending, "a review should be pending");
    assert.equal(pending.runId, started.runId);
    assert.deepEqual(pending.modelSelection, ["inspect"]);

    const invalid = await call("lattice_review", { id: "latest", action: "replace", selected: ["nope"] });
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, /invalid_request/);

    const answered = await call("lattice_review", {
      id: started.runId.slice(0, 8),
      action: "replace",
      selected: ["fix-add"],
      reviewId: pending.reviewId,
    });
    assert.equal(JSON.parse(answered.text).accepted, true);

    let status = "incomplete";
    let run: { status: string; summary?: string } = { status };
    for (let attempt = 0; attempt < 300 && status === "incomplete"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = JSON.parse((await call("lattice_show_run", { id: started.runId })).text);
      status = run.status;
    }
    assert.equal(status, "completed");
    assert.match(run.summary ?? "", /search solved/);
  } finally {
    await closeModel();
  }
});
