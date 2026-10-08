import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAgentExperimentExecutor,
  createOpenCodeAdapter,
  createQwenCodeAdapter,
  type CleanupPolicy,
} from "@lattice/agents";
import type { RunTaskOptions } from "@lattice/core";
import { runCommand } from "@lattice/execution";
import {
  cassetteCommandRunner,
  cassetteDecision,
  cassetteExecutor,
  cassetteGenerator,
  cassetteVerifier,
  type CassetteIo,
} from "./cassette.js";
import type { DecisionProvider, Verifier } from "@lattice/protocol";
import {
  createWitnessVerifier,
  resolveTsr,
  validateVerifySpec,
  witnessArgs,
  type TesseraVerifySpec,
} from "@lattice/tessera";
import type {
  AutonomyMode,
  DecisionReviewer,
} from "@lattice/search";
import {
  OpenAICompatibleDecisionProvider,
  OpenAICompatibleGeneratorProvider,
  RandomDecisionProvider,
  seededRandom,
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

export interface CommandVerifyConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Verify with `tsr witness` (+ optional `tsr run` cases); evidence is the witness JSON. */
export interface TesseraVerifyConfig {
  tessera: TesseraVerifySpec;
}

export type VerifyConfig = CommandVerifyConfig | TesseraVerifyConfig;

/**
 * Uniform choice among generated candidates: the baseline for comparing a
 * decision model (docs/mvp.md Milestone C). `seed` makes a run replayable.
 */
export interface RandomDecisionConfig {
  provider: "random";
  seed?: number;
}

export function isTesseraVerify(verify: VerifyConfig): verify is TesseraVerifyConfig {
  return "tessera" in verify;
}

/** The executable a verify config runs, for doctor checks. */
export function verifyExecutable(verify: VerifyConfig): string {
  return isTesseraVerify(verify) ? resolveTsr(verify.tessera.tsr) : verify.command;
}

/** One-line description of a verify config. */
export function describeVerify(verify: VerifyConfig): string {
  if (!isTesseraVerify(verify)) return [verify.command, ...(verify.args ?? [])].join(" ");
  const cases = verify.tessera.cases?.length;
  return [
    resolveTsr(verify.tessera.tsr),
    ...witnessArgs(verify.tessera.file, verify.tessera),
    cases ? `(+${cases} tsr run case${cases === 1 ? "" : "s"})` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
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
    decision?: ModelEndpointConfig | RandomDecisionConfig;
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
      const decision = value.models.decision;
      if (isObject(decision) && decision.provider === "random") {
        if (
          decision.seed !== undefined &&
          (typeof decision.seed !== "number" || !Number.isInteger(decision.seed))
        ) {
          throw new Error("models.decision.seed must be an integer");
        }
        config.models.decision = decision as unknown as RandomDecisionConfig;
      } else {
        config.models.decision = validateModel(decision, "models.decision");
      }
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
    if (value.verify.tessera !== undefined) {
      if (value.verify.command !== undefined) {
        throw new Error("verify takes either command or tessera, not both");
      }
      if (!isObject(value.verify.tessera)) throw new Error("verify.tessera must be an object");
      try {
        validateVerifySpec(value.verify.tessera as unknown as TesseraVerifySpec);
      } catch (error) {
        throw new Error(`verify.tessera: ${error instanceof Error ? error.message : String(error)}`);
      }
      config.verify = value.verify as unknown as TesseraVerifyConfig;
      return finishParse(value, config);
    }
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
    config.verify = value.verify as unknown as CommandVerifyConfig;
  }

  return finishParse(value, config);
}

function finishParse(
  value: Record<string, unknown>,
  config: LatticeConfig,
): LatticeConfig {
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
): DecisionProvider | undefined {
  const model = config.models?.decision ?? config.model;
  if (!model) return undefined;
  if (model.provider === "random") {
    return new RandomDecisionProvider(
      model.seed === undefined ? Math.random : seededRandom(model.seed),
      { allowUnknown: false },
    );
  }
  return new OpenAICompatibleDecisionProvider(endpointConfig(model));
}

export * from "./cassette.js";

export function createRunTaskOptions(
  config: LatticeConfig,
  hooks: { reviewer?: DecisionReviewer; cassette?: CassetteIo } = {},
): RunTaskOptions {
  const options = buildRunTaskOptions(config, hooks);
  return hooks.cassette ? withCassette(options, hooks.cassette) : options;
}

/** Route every non-deterministic call of a run through a cassette. */
function withCassette(options: RunTaskOptions, io: CassetteIo): RunTaskOptions {
  return {
    ...options,
    commandRunner: cassetteCommandRunner(io, options.commandRunner ?? runCommand),
    ...(options.verifier ? { verifier: cassetteVerifier(io, options.verifier) } : {}),
    ...(options.search
      ? {
          search: {
            ...options.search,
            generator: cassetteGenerator(io, options.search.generator),
            decision: cassetteDecision(io, options.search.decision),
            executor: cassetteExecutor(io, options.search.executor),
          },
        }
      : {}),
  };
}

function buildRunTaskOptions(
  config: LatticeConfig,
  hooks: { reviewer?: DecisionReviewer },
): RunTaskOptions {
  const verify = config.verify;
  const verifier: Verifier | undefined =
    verify && isTesseraVerify(verify) ? createWitnessVerifier(verify.tessera) : undefined;
  const verifyCommand =
    verify && !isTesseraVerify(verify)
      ? {
          command: verify.command,
          args: verify.args,
          timeoutMs: verify.timeoutMs,
          maxOutputBytes: verify.maxOutputBytes,
        }
      : undefined;

  if ((config.mode ?? "auto") === "observe") {
    return { verifyCommand, verifier };
  }

  const decisionModel = config.models?.decision ?? config.model;
  const generatorModel = config.models?.generator ?? config.model;

  const missing = [
    !decisionModel ? "model/models.decision" : undefined,
    !generatorModel ? "model/models.generator" : undefined,
    !config.agent ? "agent" : undefined,
    !verifyCommand && !verifier ? "verify" : undefined,
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `mode=auto requires configuration for: ${missing.join(", ")}`,
    );
  }

  const decision = createDecisionProvider(config)!;
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
    verifier,
    search: {
      decision,
      generator,
      executor: createAgentExperimentExecutor({
        adapter: agent,
        verifyCommand,
        verifier,
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
