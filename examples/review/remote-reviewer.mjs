#!/usr/bin/env node
// Act as the human-in-the-loop for Lattice's supervised/manual decisions
// from another program, via the daemon's review API.
//
//   npm run build && node examples/review/remote-reviewer.mjs
//
// Fully offline: the project uses a *fake* OpenAI-compatible model and a fake
// coding worker (from @lattice/service/testing), but everything else is real:
// git worktree isolation, the search loop, and the test suite as verifier.
// The fake model always picks "inspect"; our reviewer overrides it.
import { LatticeClient } from "@lattice/sdk";
import { startLatticeServer } from "@lattice/server";
import { createAutoModeFixture } from "@lattice/service/testing";

const { cwd, closeModel } = await createAutoModeFixture();
const server = await startLatticeServer({ port: 0, cwd });
const client = new LatticeClient({ baseUrl: server.url });

// A trivial review policy. Real reviewers: a person, a stronger model, CI rules.
function review(pending) {
  const edit = pending.choices.find((choice) => /patch|fix/i.test(choice.label));
  return edit && !pending.modelSelection.includes(edit.id)
    ? { action: "replace", selected: [edit.id], note: "prefer an experiment that tests could verify" }
    : { action: "approve" };
}

try {
  const accepted = await client.submitTask("fix the failing add test", {
    mode: "configured", // honour .lattice/config.json (mode: auto, autonomy: manual)
    review: "remote", // park review requests for us instead of blocking
  });
  console.log(`run ${accepted.runId.slice(0, 8)} started; streaming events\n`);

  for await (const event of client.streamEvents(accepted.runId)) {
    const kind = event.payload?.type;
    console.log(`  #${String(event.seq).padStart(2)} ${event.type}${kind ? ` (${kind})` : ""}`);

    if (kind === "decision.review.requested") {
      const pending = await client.getReview(accepted.runId);
      const answer = review(pending);
      console.log(`\n  review needed: ${pending.question}`);
      console.log(`    because: ${pending.reasons.join("; ")}`);
      console.log(`    model picked: ${pending.modelSelection.join(", ")} (confidence ${pending.confidence})`);
      console.log(`    options: ${pending.choices.map((c) => `${c.id}="${c.label}"`).join(", ")}`);
      console.log(`    answering: ${answer.action}${answer.selected ? ` → ${answer.selected}` : ""}\n`);
      await client.answerReview(accepted.runId, { ...answer, reviewId: pending.reviewId });
    }
  }

  const run = await client.getRun(accepted.runId);
  console.log(`\n${run.summary}`);
  for (const item of run.tap?.evidence ?? []) {
    console.log(`  ${item.verified ? "✓" : "?"} ${item.kind.padEnd(10)} ${item.summary.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  if (!/search solved/.test(run.summary ?? "")) process.exitCode = 1;
} finally {
  await server.close();
  await closeModel();
}
