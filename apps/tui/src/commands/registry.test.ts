import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSlashCommand, type CommandContext } from "./registry.js";
import type { FeedItem } from "../state/types.js";

function createMockContext() {
  const items: Array<Omit<FeedItem, "id" | "timestamp">> = [];
  const state = {
    cleared: false,
    exited: false,
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
