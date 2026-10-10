import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyWitness } from "@lattice/tessera";
import { dispatchSlashCommand, type CommandContext } from "./registry.js";
import type { FeedItem } from "../state/types.js";

function createMockContext() {
  const items: Array<Omit<FeedItem, "id" | "timestamp">> = [];
  const state = {
    cleared: false,
    exited: false,
    reloaded: false,
  };

  const ctx: CommandContext = {
    cwd: process.cwd(),
    workflow: "plan",
    setWorkflow: () => {},
    setProject: () => {},
    runWorkflow: async () => {},
    addFeedItem: (item) => items.push(item),
    clearFeed: () => {
      state.cleared = true;
    },
    setDiff: () => {},
    exit: () => {
      state.exited = true;
    },
    reloadConfig: async () => {
      state.reloaded = true;
    },
  };

  return { ctx, items, state };
}

test("dispatchSlashCommand ignores non-slash tasks", async () => {
  const mock = createMockContext();
  const handled = await dispatchSlashCommand("fix the tests", mock.ctx);
  assert.equal(handled, false);
  assert.equal(mock.items.length, 0);
});

test("dispatchSlashCommand handles /help", async () => {
  const mock = createMockContext();
  const handled = await dispatchSlashCommand("/help", mock.ctx);
  assert.equal(handled, true);
  assert.equal(mock.items.length, 1);
  assert.match(mock.items[0]?.text ?? "", /Available Slash Commands/);
});

test("dispatchSlashCommand handles /clear and /exit", async () => {
  const mock = createMockContext();
  await dispatchSlashCommand("/clear", mock.ctx);
  assert.equal(mock.state.cleared, true);

  await dispatchSlashCommand("/exit", mock.ctx);
  assert.equal(mock.state.exited, true);
});

test("dispatchSlashCommand reports unknown command", async () => {
  const mock = createMockContext();
  const handled = await dispatchSlashCommand("/bogus", mock.ctx);
  assert.equal(handled, true);
  assert.equal(mock.items.length, 1);
  assert.match(mock.items[0]?.text ?? "", /Unknown slash command '\/bogus'/);
});

test("/show displays saved Tessera diagnostics and rejects corrupt success evidence", async () => {
  const mock = createMockContext();
  mock.ctx.cwd = await mkdtemp(join(tmpdir(), "lattice-show-witness-"));
  const document = JSON.parse(await readFile(new URL("../../../../packages/tessera/fixtures/foreign_syntax.json", import.meta.url), "utf8"));
  const record = { schema: "lattice.tessera-verification/v0", file: "foreign.tes", cases: [],
    witness: { command: "compiler-that-does-not-exist", args: [], exitCode: 1,
      verdict: classifyWitness(document, 1), document, durationMs: 1 } };
  const dir = join(mock.ctx.cwd, ".lattice", "runs");
  await mkdir(dir, { recursive: true });
  const events = [
    { type: "run.started", payload: { task: "check syntax", cwd: mock.ctx.cwd } },
    { type: "tool.completed", payload: { tool: "tessera.witness", record } },
    { type: "run.completed", payload: { summary: "captured evidence" } },
  ].map((event, index) => ({ ...event, runId: "cf1234", seq: index + 1, at: "2026-10-10T00:00:00Z" }));
  const path = join(dir, "cf1234.jsonl");
  await writeFile(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  await dispatchSlashCommand("/show latest", mock.ctx);
  assert.match(mock.items.at(-1)?.text ?? "", /Witness: fail[\s\S]*E-syntax-foreign[\s\S]*help:/);
  document.outcome = "pass";
  await writeFile(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  await dispatchSlashCommand("/show cf1234", mock.ctx);
  assert.match(mock.items.at(-1)?.text ?? "", /Untrusted saved evidence/);
  assert.doesNotMatch(mock.items.at(-1)?.text ?? "", /Witness: pass/);
});
