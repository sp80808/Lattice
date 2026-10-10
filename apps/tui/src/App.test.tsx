import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
