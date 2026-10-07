import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeOptions {
  /** CLI to run; defaults to `$CLAUDE_BIN`, then `claude`. */
  command?: string;
  /** Passed as `--model`; the CLI's default model otherwise. */
  model?: string;
  extraArgs?: string[];
}

interface ClaudeCodeResult {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Arguments for one tool-less, non-persisted `claude -p` call. */
export function claudeCodeArgs(system: string, options: ClaudeCodeOptions = {}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (system) args.push("--system-prompt", system);
  if (options.model) args.push("--model", options.model);
  return [...args, ...(options.extraArgs ?? [])];
}

/** Failures that every later call will repeat map to the statuses the comparison stops on. */
function failureStatus(message: string): number {
  if (/not logged in|\/login|authentication/i.test(message)) return 401;
  if (/limit/i.test(message)) return 429;
  return 502;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Serve OpenAI-style chat completions from the Claude Code CLI, so the
 * OpenAI-compatible providers can run on a Claude plan without an API key.
 * Pass it as `fetchImpl`. Each call runs in an empty temporary directory with
 * no tools. Usage includes cache tokens as input; `cost` is the CLI's
 * `total_cost_usd`, which is list price even when a plan pays for the call.
 */
export function claudeCodeFetch(options: ClaudeCodeOptions = {}): typeof fetch {
  const command = options.command ?? process.env.CLAUDE_BIN ?? "claude";
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const messages = body.messages ?? [];
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const prompt = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");

    const cwd = await mkdtemp(join(tmpdir(), "lattice-claude-code-"));
    try {
      const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(command, claudeCodeArgs(system, options), { cwd, stdio: ["pipe", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
          init?.signal?.addEventListener("abort", () => child.kill());
          child.stdin.end(prompt);
        },
      );

      let parsed: ClaudeCodeResult;
      try {
        parsed = JSON.parse(stdout) as ClaudeCodeResult;
      } catch {
        const message = `${command} exited ${code}: ${(stderr || stdout).slice(0, 500)}`;
        return json({ error: message }, failureStatus(message));
      }
      if (parsed.is_error || code !== 0) {
        const message = parsed.result ?? `${command} exited ${code}`;
        return json({ error: message }, failureStatus(message));
      }

      const usage = parsed.usage ?? {};
      const input =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      const output = usage.output_tokens ?? 0;
      return json(
        {
          choices: [{ message: { content: parsed.result ?? "" } }],
          usage: {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
            cost: parsed.total_cost_usd,
          },
        },
        200,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }) as typeof fetch;
}
