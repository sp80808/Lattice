import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.js");

function lattice(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, LATTICE_CONFIG: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("help, version and usage errors", () => {
  assert.match(lattice("--help").stdout, /Usage:/);
  assert.match(lattice("--version").stdout, /^\d+\.\d+\.\d+/);
  const bad = lattice("runs", "--bogus");
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--bogus/);
});

test("init, run, runs and show work end-to-end with -C before the command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-cli-"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"console.log('suite ok')\"" } }),
  );

  const init = lattice("-C", cwd, "init", "--preset", "observe", "--json");
  assert.equal(init.code, 0, init.stderr);
  const written = JSON.parse(init.stdout);
  assert.deepEqual(written.config.verify.args, ["test"]);
  assert.equal(JSON.parse(await readFile(written.path, "utf8")).mode, "observe");
  assert.equal(lattice("-C", cwd, "init", "--preset", "observe").code, 1);

  const run = lattice("-C", cwd, "inspect", "the", "repo", "--json");
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.runtimeMode, "observe");
  assert.equal(result.tap.task, "inspect the repo");

  const runs = JSON.parse(lattice("runs", "-C", cwd, "--json").stdout);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, result.runId);

  const shown = lattice("--cwd", cwd, "show", result.runId.slice(0, 8));
  assert.match(shown.stdout, /status:\s+completed/);
  assert.match(shown.stdout, /suite ok/);

  const followed = lattice("-C", cwd, "show", "latest", "--follow");
  assert.match(followed.stdout, /run\.started[\s\S]*run\.completed/);
  assert.match(followed.stdout, /status:\s+completed/);
  const followedJson = lattice("-C", cwd, "show", "--follow", "--json").stdout.trim().split("\n");
  assert.equal(JSON.parse(followedJson.at(-1)!).type, "run.completed");

  const doctor = lattice("-C", cwd, "doctor", "--offline", "--json");
  assert.equal(JSON.parse(doctor.stdout).configPath, written.path);
});

test("`lattice mcp` speaks MCP over stdio", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-cli-mcp-"));
  const child = spawn(process.execPath, [CLI, "mcp", "-C", cwd], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));

  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lattice_run", arguments: { task: "hello from mcp" } } });
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));

  const messages = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.find((m) => m.id === 1).result.serverInfo.name, "lattice");
  const call = messages.find((m) => m.id === 2).result;
  assert.equal(call.isError, undefined);
  assert.equal(JSON.parse(call.content[0].text).mode, "observe");
});
