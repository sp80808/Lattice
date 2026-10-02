/**
 * Test fixtures shared by Lattice packages (import from "@lattice/service/testing").
 * Not part of the runtime API.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hermetic auto-mode fixture: a git repo with a failing test, a fake
 * OpenAI-compatible model server, and a fake worker that patches the bug.
 */
export async function createAutoModeFixture(): Promise<{ cwd: string; closeModel: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-auto-"));
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "test"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(cwd, "src", "calc.js"), "export const add = (a, b) => a - b;\n");
  await writeFile(
    join(cwd, "test", "calc.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add } from "../src/calc.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n',
  );

  const worker = join(cwd, "..", `${cwd.split("/").pop()}-worker.mjs`);
  await writeFile(
    worker,
    '#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from "node:fs";\nconst f = "src/calc.js";\nwriteFileSync(f, readFileSync(f, "utf8").replace("a - b", "a + b"));\nconsole.log(JSON.stringify({ ok: true }));\n',
    { mode: 0o755 },
  );

  const model = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = JSON.stringify(JSON.parse(body).messages);
    const content = text.includes("Propose up to")
      ? JSON.stringify({
          candidates: [
            { id: "inspect", label: "Inspect the module", action: "read src/calc.js", expectedEvidence: "source", estimatedCost: "low" },
            { id: "fix-add", label: "Patch the add operator", action: "use + in add", expectedEvidence: "tests pass", estimatedCost: "medium" },
          ],
        })
      : JSON.stringify({ selected: "inspect", scores: { inspect: 0.9, "fix-add": 0.1 }, confidence: 0.9 });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>((resolveListen) => model.listen(0, "127.0.0.1", resolveListen));
  const { port } = model.address() as AddressInfo;

  await mkdir(join(cwd, ".lattice"));
  await writeFile(
    join(cwd, ".lattice", "config.json"),
    JSON.stringify({
      mode: "auto",
      autonomy: { mode: "manual" },
      model: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake" },
      agent: { preset: "qwen-code", command: worker },
      verify: { command: process.execPath, args: ["--test"], timeoutMs: 60000 },
      search: { maxRounds: 2, candidatesPerRound: 2 },
      workspace: { cleanup: "always" },
    }),
  );
  // Same as `lattice init`: run logs are local and must not dirty the repo.
  await writeFile(join(cwd, ".lattice", ".gitignore"), "runs/\n");
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "broken add");

  return {
    cwd,
    closeModel: () => new Promise<void>((resolveClose) => model.close(() => resolveClose())),
  };
}
