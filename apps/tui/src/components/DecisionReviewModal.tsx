import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ReviewRequest, ReviewOutcome } from "../state/types.js";
import { ICONS } from "../theme/icons.js";

interface DecisionReviewModalProps {
  request: ReviewRequest;
  onResolve: (outcome: ReviewOutcome) => void;
}

export const DecisionReviewModal: React.FC<DecisionReviewModalProps> = ({ request, onResolve }) => {
  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState("");

  useInput((input, key) => {
    if (refining) return;

    if (key.return || input.toLowerCase() === "a") {
      onResolve({ action: "approve" });
      return;
    }

    if (input.toLowerCase() === "s") {
      onResolve({ action: "stop" });
      return;
    }

    if (input.toLowerCase() === "r") {
      setRefining(true);
      return;
    }

    const num = Number.parseInt(input, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= request.frame.choices.length) {
      const selectedChoice = request.frame.choices[num - 1];
      if (selectedChoice) {
        onResolve({
          action: "replace",
          selected: [selectedChoice.id],
          note: `User selected option ${num} via TUI`,
        });
      }
    }
  });

  const handleRefineSubmit = (value: string) => {
    onResolve({
      action: "refine",
      note: value.trim() || undefined,
    });
  };

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellowBright" paddingX={1} marginY={1}>
      <Text color="yellowBright" bold>
        {ICONS.warn} Decision Review Required — Round {request.round}
      </Text>

      <Box marginY={1} flexDirection="column">
        <Text color="white" bold>
          Question: <Text color="cyanBright">{request.frame.question}</Text>
        </Text>
        {request.reasons.length > 0 && (
          <Text color="gray">
            Reasons: {request.reasons.join("; ")}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray" bold>Options:</Text>
        {request.frame.choices.map((choice, index) => {
          const isSelected = request.decision.selected.includes(choice.id);
          return (
            <Box key={choice.id} columnGap={1}>
              <Text color={isSelected ? "greenBright" : "white"}>
                [{index + 1}] {choice.id}: {choice.label}
              </Text>
              {choice.detail && <Text color="gray">— {choice.detail}</Text>}
              {isSelected && <Text color="greenBright" bold>[MODEL PICK]</Text>}
            </Box>
          );
        })}
      </Box>

      {refining ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyanBright">Refinement instructions: </Text>
          <TextInput
            value={refineText}
            onChange={setRefineText}
            onSubmit={handleRefineSubmit}
            placeholder="Type guidance for model search and press Enter..."
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="yellowBright" bold>
            Controls: [Enter/a] Approve model choice | [1-{request.frame.choices.length}] Pick candidate | [r] Refine | [s] Stop
          </Text>
        </Box>
      )}
    </Box>
  );
};
