#!/usr/bin/env bash
# Wire Lattice into coding-agent clients as an MCP server, and check the
# worker agents Lattice itself drives (qwen, opencode).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/setup-agents.sh [options]

  --client C     where to register the Lattice MCP server (repeatable):
                   claude   Claude Code  (claude mcp add)
                   codex    Codex CLI    (codex mcp add; always user-global)
                   gemini   Gemini CLI   (gemini mcp add)
                   cursor   Cursor       (.cursor/mcp.json)
                   print    print a generic mcpServers JSON block (default)
                   all      every client above whose CLI/config is found
  --scope S      project (default) | user | local (claude only)
  --project DIR  project directory for project-scoped registration (default: cwd)
  --name N       MCP server name (default: lattice)
  --force        replace an existing registration with the same name
  --dry-run      print what would run
  -h, --help     show this help

Registration points each client at: node <this checkout>/apps/cli/dist/index.js mcp
EOF
}

CLIENTS=() SCOPE=project PROJECT="$PWD" NAME=lattice FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --client) CLIENTS+=("${2:?--client needs a value}"); shift ;;
    --scope) SCOPE="${2:?--scope needs a value}"; shift ;;
    --project) PROJECT="${2:?--project needs a value}"; shift ;;
    --name) NAME="${2:?--name needs a value}"; shift ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done
[ ${#CLIENTS[@]} -gt 0 ] || CLIENTS=(print)
case "$SCOPE" in project|user|local) ;; *) die "--scope must be project, user or local" ;; esac

require_node
require_built_cli
[ -d "$PROJECT" ] || die "project directory not found: $PROJECT"
PROJECT="$(cd "$PROJECT" && pwd)"
NODE_BIN="$(command -v node)"

if [ "${CLIENTS[0]}" = all ]; then
  CLIENTS=()
  has claude && CLIENTS+=(claude)
  has codex && CLIENTS+=(codex)
  has gemini && CLIENTS+=(gemini)
  { has cursor-agent || [ -d "$HOME/.cursor" ]; } && CLIENTS+=(cursor)
  [ ${#CLIENTS[@]} -gt 0 ] || { warn "no supported clients found; printing a generic config"; CLIENTS=(print); }
fi

register_claude() {
  has claude || { warn "claude not found: https://docs.claude.com/claude-code"; return; }
  info "Claude Code ($SCOPE scope)"
  cd "$PROJECT"
  if claude mcp get "$NAME" >/dev/null 2>&1; then
    if [ "$FORCE" = 0 ]; then ok "already registered as '$NAME' (use --force to replace)"; return; fi
    run claude mcp remove --scope "$SCOPE" "$NAME" || true
  fi
  run claude mcp add --scope "$SCOPE" "$NAME" -- "$NODE_BIN" "$LATTICE_CLI" mcp
  if [ "$SCOPE" = project ] && [ "$DRY_RUN" = 0 ]; then
    ok "wrote $PROJECT/.mcp.json (Claude asks each user to approve project servers)"
  fi
}

register_codex() {
  has codex || { warn "codex not found: https://github.com/openai/codex"; return; }
  info "Codex (user-global ~/.codex/config.toml; tools use the directory Codex runs in)"
  if codex mcp get "$NAME" >/dev/null 2>&1; then
    if [ "$FORCE" = 0 ]; then ok "already registered as '$NAME' (use --force to replace)"; return; fi
    run codex mcp remove "$NAME" || true
  fi
  run codex mcp add "$NAME" -- "$NODE_BIN" "$LATTICE_CLI" mcp
}

register_gemini() {
  has gemini || { warn "gemini not found: https://github.com/google-gemini/gemini-cli"; return; }
  local scope="$SCOPE"
  [ "$scope" = local ] && scope=project
  info "Gemini CLI ($scope scope)"
  cd "$PROJECT"
  [ "$FORCE" = 1 ] && { run gemini mcp remove --scope "$scope" "$NAME" >/dev/null 2>&1 || true; }
  run gemini mcp add --scope "$scope" "$NAME" "$NODE_BIN" "$LATTICE_CLI" mcp
}

register_cursor() {
  local file
  if [ "$SCOPE" = user ]; then file="$HOME/.cursor/mcp.json"; else file="$PROJECT/.cursor/mcp.json"; fi
  info "Cursor ($file)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  \033[2m(would merge mcpServers.%s into %s)\033[0m\n' "$NAME" "$file"
    return
  fi
  mkdir -p "$(dirname "$file")"
  # Merge with node so existing servers and formatting-insensitive JSON survive.
  FILE="$file" NAME="$NAME" NODE_BIN="$NODE_BIN" CLI="$LATTICE_CLI" FORCE="$FORCE" node --input-type=module -e '
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const { FILE, NAME, NODE_BIN, CLI, FORCE } = process.env;
    const config = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
    config.mcpServers ??= {};
    if (config.mcpServers[NAME] && FORCE !== "1") {
      console.log(`  already registered as '"'"'${NAME}'"'"' (use --force to replace)`);
      process.exit(0);
    }
    config.mcpServers[NAME] = { command: NODE_BIN, args: [CLI, "mcp"] };
    writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n");
    console.log(`  wrote ${FILE}`);
  '
}

print_generic() {
  info "Generic MCP client config (Claude Desktop, Windsurf, Zed, ...)"
  cat <<EOF
{
  "mcpServers": {
    "$NAME": {
      "command": "$NODE_BIN",
      "args": ["$LATTICE_CLI", "mcp", "-C", "$PROJECT"]
    }
  }
}
EOF
}

for client in "${CLIENTS[@]}"; do
  case "$client" in
    claude) (register_claude) ;;
    codex) (register_codex) ;;
    gemini) (register_gemini) ;;
    cursor) (register_cursor) ;;
    print) print_generic ;;
    *) die "unknown client: $client" ;;
  esac
done

info "Worker agents Lattice can drive (agent.preset)"
if has qwen; then ok "qwen-code: $(command -v qwen)"; else warn "qwen-code missing: npm install -g @qwen-code/qwen-code"; fi
if has opencode; then ok "opencode: $(command -v opencode)"; else warn "opencode missing: see https://opencode.ai"; fi

cat <<EOF

Tools exposed: lattice_run, lattice_runs, lattice_show_run, lattice_decide, lattice_stats, lattice_doctor
lattice_run defaults to mode=observe; agents must pass mode=configured to start Lattice's own search.
EOF
