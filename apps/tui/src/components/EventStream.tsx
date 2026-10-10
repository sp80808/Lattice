import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { FeedItem, TuiMode } from "../state/types.js";
import { ICONS, LATTICE_SPINNER_FRAMES } from "../theme/icons.js";

interface EventStreamProps {
  feed: FeedItem[];
  mode: TuiMode;
  activeTask?: string;
  activePhase?: string;
}

export const EventStream: React.FC<EventStreamProps> = ({
  feed,
  mode,
  activeTask,
  activePhase,
}) => {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (mode !== "running") return;
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % LATTICE_SPINNER_FRAMES.length);
    }, 150);
    return () => clearInterval(interval);
  }, [mode]);

  const visibleFeed = feed.slice(-6); // Display most recent items

  return (
    <Box flexDirection="column" marginY={1}>
      {visibleFeed.map((item) => (
        <Box key={item.id} flexDirection="column" marginBottom={1}>
          {item.title && (
            <Text
              bold
              color={
                item.type === "error"
                  ? "redBright"
                  : item.type === "result"
                  ? "greenBright"
                  : item.type === "task"
                  ? "cyanBright"
                  : "white"
              }
            >
              {item.title}
            </Text>
          )}
          {item.text && (
            <Box paddingLeft={1}>
              <Text color={item.type === "error" ? "red" : "gray"}>
                {item.text}
              </Text>
            </Box>
          )}
        </Box>
      ))}

      {mode === "running" && (
        <Box
          borderStyle="round"
          borderColor="magentaBright"
          paddingX={1}
          marginY={1}
          flexDirection="column"
        >
          <Box columnGap={1}>
            <Text color="cyanBright">
              <Spinner type="dots" />
            </Text>
            <Text color="magentaBright" bold>
              {LATTICE_SPINNER_FRAMES[frameIndex]}
            </Text>
            <Text color="white" bold>
              Executing: {activeTask || "Task in progress..."}
            </Text>
          </Box>
          {activePhase && (
            <Box paddingLeft={2} marginTop={1}>
              <Text color="gray">
                {ICONS.arrowRight} {activePhase}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
