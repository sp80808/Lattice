import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAppType, classifyPlatforms, classifyTask, fingerprintProject } from "./index.js";

async function tempProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lattice-fingerprint-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

test("fingerprint inspects TypeScript/React manifests deterministically", async () => {
  const root = await tempProject({
    "package.json": JSON.stringify({
      name: "demo",
      packageManager: "pnpm@10.0.0",
      dependencies: { react: "^18.3.1", next: "^15.0.0" },
      devDependencies: { typescript: "^5.9.0", vitest: "^2.0.0" },
      scripts: { test: "vitest run", build: "tsc -b" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json": "{ \"compilerOptions\": {} }",
    "src/App.tsx": "export const App = () => null;\n",
  });

  try {
    const fingerprint = await fingerprintProject(root);

    assert.equal(fingerprint.source, "filesystem");
    assert.deepEqual(fingerprint.languages, ["javascript", "typescript"]);
    assert.ok(fingerprint.stacks.includes("react"));
    assert.ok(fingerprint.stacks.includes("next"));
    assert.ok(fingerprint.stacks.includes("typescript"));
    assert.deepEqual(fingerprint.packageManagers, ["pnpm"]);
    assert.deepEqual(fingerprint.testCommands, ["vitest run"]);
    assert.deepEqual(fingerprint.buildCommands, ["tsc -b"]);
    assert.equal(fingerprint.appType, "web-app");
    assert.ok(fingerprint.platforms.includes("browser"));
    assert.ok(fingerprint.frameworks.includes("React"));
    assert.ok(fingerprint.manifests.some((manifest) => manifest.path === "package.json"));
    // A revision-less fingerprint must say so instead of inventing one.
    assert.ok(
      fingerprint.uncertainties.some((item) => /revision/i.test(item)),
      "expected a revision uncertainty",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint does not confuse TanStack Start with Next.js routing", async () => {
  const root = await tempProject({
    "package.json": JSON.stringify({
      name: "start-app",
      dependencies: { "@tanstack/react-start": "^1.0.0", react: "^18.3.1" },
      devDependencies: { vite: "^6.0.0", typescript: "^5.9.0" },
    }),
  });

  try {
    const fingerprint = await fingerprintProject(root);
    assert.ok(!fingerprint.stacks.includes("next"), "Next.js must not be inferred from React");
    assert.ok(fingerprint.stacks.includes("vite"));
    assert.equal(fingerprint.appType, "web-app");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint detects Rust and Tessera stacks", async () => {
  const root = await tempProject({
    "Cargo.toml": '[package]\nname = "tesc"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
    "Cargo.lock": "# lock\n",
    "Makefile": "all:\n\ttesc build\n",
    "src/main.tes": "module main\n",
  });

  try {
    const fingerprint = await fingerprintProject(root);
    assert.deepEqual(fingerprint.languages, ["rust", "tessera"]);
    assert.ok(fingerprint.stacks.includes("rust"));
    assert.ok(fingerprint.stacks.includes("compiler"));
    assert.ok(fingerprint.dependencies.some((dep) => dep.includes("serde")));
    assert.deepEqual(fingerprint.packageManagers, ["cargo"]);
    assert.ok(fingerprint.buildCommands.includes("make"));
    assert.equal(fingerprint.appType, "compiler");
    assert.ok(fingerprint.platforms.includes("native"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint records CI workflows as inspected facts", async () => {
  const root = await tempProject({
    "package.json": JSON.stringify({ name: "ci", devDependencies: { typescript: "^5" } }),
    ".github/workflows/ci.yml": "name: ci\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  });

  try {
    const fingerprint = await fingerprintProject(root);
    assert.deepEqual(fingerprint.ci, ["ci.yml"]);
    assert.ok(
      fingerprint.manifests.some(
        (manifest) => manifest.kind === "ci" && manifest.path === ".github/workflows/ci.yml",
      ),
    );
    assert.ok(fingerprint.testCommands.includes("ci-defined"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint is stable for identical manifests", async () => {
  const contents = {
    "package.json": JSON.stringify({ name: "stable", dependencies: { react: "^18.0.0" } }),
  };
  const a = await tempProject(contents);
  const b = await tempProject(contents);
  try {
    const first = await fingerprintProject(a);
    const second = await fingerprintProject(b);
    assert.equal(first.fingerprintSha, second.fingerprintSha);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("fingerprint reports unknown rather than guessing", async () => {
  const root = await tempProject({ "README.md": "# nothing to see\n" });
  try {
    const fingerprint = await fingerprintProject(root);
    assert.deepEqual(fingerprint.languages, []);
    assert.deepEqual(fingerprint.stacks, []);
    assert.equal(fingerprint.appType, "unknown");
    assert.equal(fingerprint.revision, undefined);
    assert.ok(fingerprint.uncertainties.some((item) => /test command/i.test(item)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifyTask is deterministic and prefers the strongest signal", () => {
  const first = classifyTask("fix the overlapping controls in the mobile studio interface");
  const second = classifyTask("fix the overlapping controls in the mobile studio interface");
  assert.deepEqual(first, second);
  assert.equal(first.class, "ui");
  assert.ok(first.confidence > 0);

  assert.equal(classifyTask("make the parser faster").class, "performance");
  assert.equal(classifyTask("upgrade to the next major").class, "upgrade");
  assert.equal(classifyTask("add dark mode").class, "feature");
  assert.equal(classifyTask("extract the duplicated parser helper into a module").class, "refactor");
  assert.equal(classifyTask("hello").class, "unknown");
});

test("classifyAppType and classifyPlatforms stay inspection-driven", () => {
  const web = classifyAppType({
    stacks: ["react", "vite"],
    dependencies: ["react"],
    devDependencies: ["vite"],
    languages: ["typescript"],
    workspace: false,
  });
  assert.equal(web, "web-app");
  assert.equal(
    classifyAppType({
      stacks: ["compiler", "tessera"],
      dependencies: [],
      devDependencies: [],
      languages: ["tessera"],
      workspace: true,
    }),
    "compiler",
  );

  assert.deepEqual(classifyPlatforms({ stacks: [], languages: [], appType: "unknown" }), [
    "cross-platform",
  ]);
  assert.deepEqual(
    classifyPlatforms({ stacks: ["wasm", "web"], languages: ["rust"], appType: "library" }).sort(),
    ["browser", "wasm"],
  );
});
