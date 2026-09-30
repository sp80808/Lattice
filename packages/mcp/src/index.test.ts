import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
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
