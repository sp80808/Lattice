import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAgentExperimentExecutor,
  createOpenCodeAdapter,
  createQwenCodeAdapter,
  type CleanupPolicy,
} from "@lattice/agents";
import type { RunTaskOptions } from "@lattice/core";
import type {
  AutonomyMode,
  DecisionReviewer,
} from "@lattice/search";
import {
  OpenAICompatibleDecisionProvider,
  OpenAICompatibleGeneratorProvider,
  type OpenAICompatibleConfig,
} from "@lattice/providers";

export type RuntimeMode = "auto" | "observe";

export interface ModelEndpointConfig {
  provider?: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  jsonMode?: boolean;
}

export interface QwenAgentConfig {
  preset: "qwen-code";
  command?: string;
  model?: string;
  approvalMode?: "default" | "auto-edit" | "auto" | "yolo";
  outputFormat?: "json" | "stream-json" | "text";
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface OpenCodeAgentConfig {
  preset: "opencode";
  command?: string;
  model?: string;
  agent?: string;
  autoApprove?: boolean;
  format?: "default" | "json";
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface VerifyConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface LatticeConfig {
  mode?: RuntimeMode;
  autonomy?: {
    mode?: AutonomyMode;
    minConfidence?: number;
    maxNormalizedEntropy?: number;
    reviewHighCost?: boolean;
    reviewQuestionWarnings?: boolean;
  };
  model?: ModelEndpointConfig;
  models?: {
    decision?: ModelEndpointConfig;
    generator?: ModelEndpointConfig;
  };
  agent?: QwenAgentConfig | OpenCodeAgentConfig;
  verify?: VerifyConfig;
  search?: {
    maxRounds?: number;
    candidatesPerRound?: number;
    topK?: number;
    parallelism?: number;
  };
  workspace?: {
    cleanup?: CleanupPolicy;
  };
}

export interface LoadedLatticeConfig {
  path: string;
  config: LatticeConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateModel(value: unknown, field: string): ModelEndpointConfig {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) {
    throw new Error(`${field}.baseUrl must be a non-empty string`);
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new Error(`${field}.model must be a non-empty string`);
  }
  if (
    value.provider !== undefined &&
    value.provider !== "openai-compatible"
  ) {
    throw new Error(`${field}.provider is not supported yet`);
  }
  return value as unknown as ModelEndpointConfig;
}

export function parseLatticeConfig(value: unknown): LatticeConfig {
  if (!isObject(value)) throw new Error("Lattice config must be a JSON object");

  const mode = value.mode ?? "auto";
  if (mode !== "auto" && mode !== "observe") {
    throw new Error("mode must be 'auto' or 'observe'");
  }

  const config: LatticeConfig = { mode };

  if (value.autonomy !== undefined) {
    if (!isObject(value.autonomy)) throw new Error("autonomy must be an object");
    const autonomyMode = value.autonomy.mode ?? "autopilot";
    if (
      autonomyMode !== "autopilot" &&
      autonomyMode !== "supervised" &&
      autonomyMode !== "manual"
    ) {
      throw new Error(
        "autonomy.mode must be 'autopilot', 'supervised', or 'manual'",
      );
    }
    config.autonomy = value.autonomy as LatticeConfig["autonomy"];
  }

  if (value.model !== undefined) config.model = validateModel(value.model, "model");

  if (value.models !== undefined) {
    if (!isObject(value.models)) throw new Error("models must be an object");
    config.models = {};
    if (value.models.decision !== undefined) {
      config.models.decision = validateModel(
        value.models.decision,
        "models.decision",
      );
    }
    if (value.models.generator !== undefined) {
      config.models.generator = validateModel(
        value.models.generator,
        "models.generator",
      );
    }
  }

  if (value.agent !== undefined) {
    if (!isObject(value.agent)) throw new Error("agent must be an object");
    if (value.agent.preset !== "qwen-code" && value.agent.preset !== "opencode") {
      throw new Error("agent.preset must be 'qwen-code' or 'opencode'");
    }
    config.agent = value.agent as unknown as QwenAgentConfig | OpenCodeAgentConfig;
  }

  if (value.verify !== undefined) {
    if (!isObject(value.verify)) throw new Error("verify must be an object");
    if (typeof value.verify.command !== "string" || !value.verify.command.trim()) {
      throw new Error("verify.command must be a non-empty string");
    }
    if (
      value.verify.args !== undefined &&
      (!Array.isArray(value.verify.args) ||
        !value.verify.args.every((arg) => typeof arg === "string"))
    ) {
      throw new Error("verify.args must be an array of strings");
    }
    config.verify = value.verify as unknown as VerifyConfig;
  }

  if (value.search !== undefined) {
    if (!isObject(value.search)) throw new Error("search must be an object");
    config.search = value.search as LatticeConfig["search"];
  }

  if (value.workspace !== undefined) {
    if (!isObject(value.workspace)) throw new Error("workspace must be an object");
    config.workspace = value.workspace as LatticeConfig["workspace"];
  }

  return config;
}

async function readConfig(path: string): Promise<LoadedLatticeConfig | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return {
      path,
      config: parseLatticeConfig(JSON.parse(raw)),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function loadLatticeConfig(
  cwdInput = process.cwd(),
  explicitPath?: string,
): Promise<LoadedLatticeConfig | undefined> {
  const cwd = resolve(cwdInput);
  const envPath = process.env.LATTICE_CONFIG;
  const requested = explicitPath ?? envPath;

  if (requested) {
    const path = isAbsolute(requested) ? requested : resolve(cwd, requested);
    const loaded = await readConfig(path);
    if (!loaded) throw new Error(`Lattice config not found: ${path}`);
    return loaded;
  }

  for (const path of [
    join(cwd, ".lattice", "config.json"),
    join(cwd, "lattice.config.json"),
  ]) {
    const loaded = await readConfig(path);
    if (loaded) return loaded;
  }

  return undefined;
}

function endpointConfig(model: ModelEndpointConfig): OpenAICompatibleConfig {
  const apiKey = model.apiKeyEnv
    ? process.env[model.apiKeyEnv]
    : undefined;

  if (model.apiKeyEnv && !apiKey) {
    throw new Error(
      `Environment variable ${model.apiKeyEnv} required by model config is not set`,
    );
  }

  return {
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey,
    timeoutMs: model.timeoutMs,
    jsonMode: model.jsonMode,
    providerName: "runtime-config",
  };
}

/** Decision provider for `models.decision ?? model`, or undefined when unconfigured. */
export function createDecisionProvider(
  config: LatticeConfig,
): OpenAICompatibleDecisionProvider | undefined {
  const model = config.models?.decision ?? config.model;
  return model
    ? new OpenAICompatibleDecisionProvider(endpointConfig(model))
    : undefined;
}

export function createRunTaskOptions(
  config: LatticeConfig,
  hooks: { reviewer?: DecisionReviewer } = {},
): RunTaskOptions {
  const verifyCommand = config.verify
    ? {
        command: config.verify.command,
        args: config.verify.args,
        timeoutMs: config.verify.timeoutMs,
        maxOutputBytes: config.verify.maxOutputBytes,
      }
    : undefined;

  if ((config.mode ?? "auto") === "observe") {
    return { verifyCommand };
  }

  const decisionModel = config.models?.decision ?? config.model;
  const generatorModel = config.models?.generator ?? config.model;

  const missing = [
    !decisionModel ? "model/models.decision" : undefined,
    !generatorModel ? "model/models.generator" : undefined,
    !config.agent ? "agent" : undefined,
    !verifyCommand ? "verify" : undefined,
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `mode=auto requires configuration for: ${missing.join(", ")}`,
    );
  }

  const decision = new OpenAICompatibleDecisionProvider(
    endpointConfig(decisionModel!),
  );
  const generator = new OpenAICompatibleGeneratorProvider(
    endpointConfig(generatorModel!),
  );

  const agent =
    config.agent!.preset === "qwen-code"
      ? createQwenCodeAdapter({
          command: config.agent!.command,
          model: config.agent!.model,
          approvalMode: config.agent!.approvalMode,
          outputFormat: config.agent!.outputFormat,
          timeoutMs: config.agent!.timeoutMs,
          extraArgs: config.agent!.extraArgs,
        })
      : createOpenCodeAdapter({
          command: config.agent!.command,
          model: config.agent!.model,
          agent: config.agent!.agent,
          autoApprove: config.agent!.autoApprove,
          format: config.agent!.format,
          timeoutMs: config.agent!.timeoutMs,
          extraArgs: config.agent!.extraArgs,
        });

  return {
    verifyCommand,
    search: {
      decision,
      generator,
      executor: createAgentExperimentExecutor({
        adapter: agent,
        verifyCommand,
        cleanup: config.workspace?.cleanup ?? "on-failure",
      }),
      maxRounds: config.search?.maxRounds,
      candidatesPerRound: config.search?.candidatesPerRound,
      topK: config.search?.topK,
      parallelism: config.search?.parallelism,
      autonomy: {
        mode: config.autonomy?.mode ?? "autopilot",
        minConfidence: config.autonomy?.minConfidence,
        maxNormalizedEntropy: config.autonomy?.maxNormalizedEntropy,
        reviewHighCost: config.autonomy?.reviewHighCost,
        reviewQuestionWarnings: config.autonomy?.reviewQuestionWarnings,
      },
      reviewer: hooks.reviewer,
    },
  };
}

export const EXAMPLE_CONFIG: LatticeConfig = {
  mode: "auto",
  autonomy: {
    mode: "supervised",
    minConfidence: 0.72,
    maxNormalizedEntropy: 0.72,
  },
  model: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3-coder",
  },
  agent: {
    preset: "qwen-code",
    approvalMode: "auto-edit",
    outputFormat: "json",
  },
  verify: {
    command: "npm",
    args: ["test"],
    timeoutMs: 120000,
  },
  search: {
    maxRounds: 4,
    candidatesPerRound: 4,
  },
};
