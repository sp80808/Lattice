import test from "node:test";
import assert from "node:assert/strict";
import { formatValue } from "../src/format.js";

test("formats values safely", () => {
  assert.equal(formatValue("hello"), "HELLO");
  assert.equal(formatValue(123), "123");
  assert.equal(formatValue(null), "");
});
