#!/usr/bin/env node
// Talk to `lattice mcp` over stdio exactly as an MCP client would.
// Useful for debugging an integration before wiring it into Claude Code/Codex.
//
//   npm run build && node examples/mcp/raw-session.mjs
import { spawn } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "apps", "cli", "dist", "index.js");
const project = await mkdtemp(join(tmpdir(), "lattice-mcp-"));
await cp(join(here, "..", "demo-repo"), project, { recursive: true });

const server = spawn(process.execPath, [cli, "mcp", "-C", project], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  const request = { jsonrpc: "2.0", id, method, params };
  console.log(`→ ${method} ${params ? JSON.stringify(params).slice(0, 100) : ""}`);
  server.stdin.write(JSON.stringify(request) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

const init = await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "raw-session-example", version: "0.0.1" },
});
console.log(`← server ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const { result: { tools } } = await call("tools/list");
console.log(`← tools: ${tools.map((tool) => tool.name).join(", ")}`);

const run = await call("tools/call", { name: "lattice_run", arguments: { task: "inspect the calculator" } });
const payload = JSON.parse(run.result.content[0].text);
console.log(`← lattice_run: ${payload.summary} (mode=${payload.mode}, run=${payload.runId.slice(0, 8)})`);

const shown = await call("tools/call", { name: "lattice_show_run", arguments: { id: "latest" } });
console.log(`← lattice_show_run: status=${JSON.parse(shown.result.content[0].text).status}`);

const failed = await call("tools/call", { name: "lattice_show_run", arguments: { id: "deadbeef" } });
console.log(`← tool error (isError=${failed.result.isError}): ${failed.result.content[0].text}`);

server.stdin.end();
await new Promise((resolve) => server.on("close", resolve));
