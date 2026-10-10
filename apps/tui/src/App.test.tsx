import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { DiffViewer } from "./components/DiffViewer.js";
import { ICONS, modeColor, nextWorkflow } from "./theme/icons.js";
import { PromptBar } from "./components/PromptBar.js";
import { DecisionReviewModal } from "./components/DecisionReviewModal.js";
import { describeEvent } from "./state/events.js";
import type { ReviewRequest, ReviewOutcome } from "./state/types.js";

async function terminal(element: React.ReactElement, columns = 80, rows = 24) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(new PassThrough(), { columns, rows });
  const frames: string[] = [];
  stdout.on("data", chunk => frames.push(String(chunk)));
  const instance = render(element, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  await delay(100);
  return {
    last: () => (frames.at(-1) || "").replace(/\x1b\[[0-9;]*m/g, ""),
    key: async (input: string) => { stdin.write(input); await delay(100); },
    resize: async (width: number, height: number) => { stdout.columns = width; stdout.rows = height; stdout.emit("resize"); await delay(100); },
    close: () => { instance.unmount(); stdin.destroy(); stdout.destroy(); },
  };
}

test("wordmark contains all seven fixed-width glyphs and mode accents differ", () => {
  assert.equal(ICONS.logo.length, 5);
  assert.ok(ICONS.logo.every(row => row.length === 41));
  assert.equal(ICONS.logo[0]?.slice(24, 29), "█████"); // I
  assert.deepEqual(["plan", "build", "auto"].map(mode => nextWorkflow(mode as "plan" | "build" | "auto")), ["build", "auto", "plan"]);
  assert.deepEqual([modeColor("plan"), modeColor("build"), modeColor("auto")], ["yellow", "cyan", "magenta"]);
});

test("a missing config is auto-initialized on launch in the selected folder", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-tui-autoinit-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const tty = await terminal(<App globals={["--cwd", cwd]} />);
  try {
    for (let attempt = 0; attempt < 60 && !existsSync(join(cwd, ".lattice", "config.json")); attempt++) {
      await delay(50);
    }
    const config = JSON.parse(await readFile(join(cwd, ".lattice", "config.json"), "utf8"));
    assert.equal(config.mode, "auto");
    assert.deepEqual(config.verify, { command: "npm", args: ["test"], timeoutMs: 120_000 });
    assert.equal(config.model.baseUrl, "http://127.0.0.1:11434/v1");
    assert.ok(typeof config.model.model === "string" && config.model.model.length > 0);
    assert.match(tty.last(), /Auto-initialized configuration/);
    assert.doesNotMatch(tty.last(), /SETUP REQUIRED/);
  } finally { tty.close(); }
});

test("reverse-tab cycles once, preserves drafts and slash suggestions; missing setup blocks coding", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-tui-"));
  const tty = await terminal(<App globals={["--cwd", cwd]} />);
  try {
    assert.match(tty.last(), /LATTICE/);
    assert.match(tty.last(), /\[PLAN\]/);
    assert.ok(tty.last().trimEnd().split("\n").length <= 24);
    await tty.key("draft task");
    await tty.key("\x1b[Z");
    assert.match(tty.last(), /\[BUILD\]/);
    assert.match(tty.last(), /draft task/);
    await tty.key("\x1b[Z");
    assert.match(tty.last(), /\[AUTO\]/);
    await tty.key("\x1b[Z");
    assert.match(tty.last(), /\[PLAN\]/);
    await tty.key("\r");
    assert.match(tty.last(), /BLOCKED/);
    assert.doesNotMatch(tty.last(), /Task Finished|VERIFIED PATCH/);
    await tty.key("/mo");
    await tty.key("\x1b[Z");
    assert.match(tty.last(), /\[BUILD\]/);
    assert.match(tty.last(), /\/mo/);
    await tty.key("\t");
    await tty.key("auto");
    await tty.key("\r");
    assert.match(tty.last(), /\[AUTO\]/);
    await tty.key("fix it");
    await tty.key("\r");
    assert.match(tty.last(), /BLOCKED/);
    await tty.resize(100, 30);
    assert.ok(tty.last().trimEnd().split("\n").length <= 30);
    await tty.resize(140, 40);
    assert.match(tty.last(), /LATTICE/);
  } finally { tty.close(); }
});

test("diff input pages beyond forty lines and closes with Escape", async () => {
  let closed = false;
  const tty = await terminal(<DiffViewer title="Recorded patch" diffText={Array.from({ length: 100 }, (_, index) => `+line ${index + 1}`).join("\n")} height={10} onClose={() => { closed = true; }} />);
  try {
    for (let index = 0; index < 6; index++) await tty.key("\x1b[6~");
    assert.match(tty.last(), /line 49/);
    await tty.key("\x1b");
    assert.equal(closed, true);
  } finally { tty.close(); }
});

test("multiline, pasted text and recalled drafts are preserved without submitting on continuation", async () => {
  const submitted: string[] = [];
  const tty = await terminal(<PromptBar columns={80} workflow="build" onSubmit={value => submitted.push(value)} />);
  try {
    await tty.key("first\\");
    await tty.key("\r");
    await tty.key("second");
    assert.deepEqual(submitted, []);
    await tty.key("\r");
    assert.deepEqual(submitted, ["first\nsecond"]);
    await tty.key("\x1b[200~pasted\r\nlines\x1b[201~");
    assert.equal(submitted.length, 1);
    await tty.key("\r");
    assert.equal(submitted[1], "pasted\nlines");
    await tty.key("draft");
    await tty.key("\x1b[A");
    assert.match(tty.last(), /pasted/);
    await tty.key("\x1b[B");
    // Multiline recall navigates within the recalled text; Ctrl+U clears it explicitly.
    await tty.key("\x15");
    await tty.key("x".repeat(400));
    assert.ok(tty.last().trimEnd().split("\n").length <= 5);
  } finally { tty.close(); }
});

test("an active PLAN retains its mode and cancellation waits for the pending provider", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-tui-active-"));
  await mkdir(join(cwd, ".lattice"));
  await writeFile(join(cwd, ".lattice", "config.json"), JSON.stringify({ model: { baseUrl: "http://fixture.invalid/v1", model: "planner" } }));
  await writeFile(join(cwd, "source.ts"), "export const x = 1;\n");
  let finish: ((response: Response) => void) | undefined;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  const tty = await terminal(<App globals={["--cwd", cwd]} />);
  try {
    await tty.key("plan x");
    await tty.key("\r");
    assert.ok(finish, "planner must actually be invoked");
    await tty.key("\x1b[Z");
    assert.match(tty.last(), /\[PLAN\]/);
    assert.match(tty.last(), /Mode locked/);
    await tty.key("\x03");
    assert.match(tty.last(), /Cancellation requested/);
    assert.match(tty.last(), /RUNNING/);
    finish!(new Response(JSON.stringify({ choices: [{ message: { content: "A bounded draft." } }] })));
    await delay(150);
    assert.match(tty.last(), /CANCELLED/);
    assert.match(tty.last(), /IDLE/);
  } finally { finish?.(new Response('{}')); tty.close(); }
});

test("review Enter cannot approve accidentally and navigation submits the actual choice ID", async () => {
  const answers: ReviewOutcome[] = [];
  const request: ReviewRequest = {
    round: 1, reasons: ["review required"], selectedCandidates: [],
    frame: { id: "frame", class: "next-action", objective: "edit", state: "source evidence", question: "Choose", criteria: [], evidenceIds: [], choices: [{ id: "real-id", label: "Inspect" }], allowUnknown: false, audit: [] },
    decision: { selected: ["real-id"], scores: { "real-id": 1 }, identity: { provider: "fixture" }, usage: { latencyMs: 1 } },
  };
  const tty = await terminal(<DecisionReviewModal request={request} onResolve={answer => answers.push(answer)} height={12} />);
  try {
    await tty.key("\r");
    assert.equal(answers.length, 0);
    await tty.key("\x1b[B");
    await tty.key("\r");
    assert.equal(answers[0]?.action, "replace");
    assert.deepEqual(answers[0]?.action === "replace" && answers[0].selected, ["real-id"]);
  } finally { tty.close(); }
});

test("event descriptions expose only recorded model, usage and verification metadata", () => {
  const model = describeEvent({ runId: "r", seq: 1, at: "2026-10-10T00:00:00Z", type: "decision.requested", payload: { event: { type: "candidates.generated", identity: { model: "actual-model" }, usage: { totalTokens: 17 }, candidates: [{ label: "Inspect source" }] } } });
  assert.match(model.text ?? "", /actual-model/);
  assert.match(model.text ?? "", /Tokens: 17/);
  assert.doesNotMatch(model.text ?? "", /Cost/);
  const check = describeEvent({ runId: "r", seq: 2, at: "2026-10-10T00:00:00Z", type: "tool.completed", payload: { result: { command: "node", exitCode: 1, stderr: "private output" } } });
  assert.match(check.text ?? "", /exit=1/);
  assert.doesNotMatch(check.text ?? "", /private output/);
});
