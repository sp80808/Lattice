import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ExecuteTaskOptions } from "@lattice/service";

type DecisionReviewer = NonNullable<ExecuteTaskOptions["reviewer"]>;

/** TTY review surface for supervised/manual autonomy. Blocks without a TTY. */
export const cliReviewer: DecisionReviewer = async (request) => {
  if (!input.isTTY || !output.isTTY) {
    return {
      action: "stop",
      note: "interactive review required but no TTY is available",
    };
  }

  console.log("");
  console.log(`Review required — round ${request.round}`);
  console.log(`Question: ${request.frame.question}`);
  console.log(`Reasons: ${request.reasons.join("; ")}`);
  console.log("Evidence:");
  for (const id of request.frame.evidenceIds) console.log(`  - ${id}`);
  console.log("Options:");
  request.frame.choices.forEach((choice, index) => {
    console.log(
      `  ${index + 1}. [${choice.id}] ${choice.label}${choice.detail ? ` — ${choice.detail}` : ""}`,
    );
  });
  console.log(`Model selection: ${request.decision.selected.join(", ")}`);

  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question(
        "Approve [Enter/a], replace with IDs [id1,id2], refine [r], or stop [s]: ",
      )
    ).trim();

    if (!answer || answer.toLowerCase() === "a") {
      return { action: "approve" };
    }
    if (answer.toLowerCase() === "r") {
      const note = await rl.question("Refinement note (optional): ");
      return { action: "refine", note: note.trim() || undefined };
    }
    if (answer.toLowerCase() === "s") {
      return { action: "stop" };
    }

    const selected = answer
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return {
      action: "replace",
      selected,
      note: "human-selected candidate override",
    };
  } finally {
    rl.close();
  }
};
