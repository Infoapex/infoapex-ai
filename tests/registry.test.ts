import assert from "node:assert/strict";
import { test } from "node:test";
import { MODULE_REGISTRY, modulesForCommand, moduleSubcommand } from "../src/registry.js";

test("doctor fans out to every module that declares a doctor mapping", () => {
  const modules = modulesForCommand("doctor").map((module) => module.name);
  assert.deepEqual(modules, ["ai-code-worker", "ai-code-review", "ai-code-docs"]);
});

test("run, plan, review, docs each resolve to exactly one module", () => {
  for (const command of ["plan", "run", "resume", "review", "docs"] as const) {
    const modules = modulesForCommand(command);
    assert.equal(modules.length, 1, `expected exactly one module for '${command}', got ${modules.length}`);
  }
  assert.equal(modulesForCommand("plan")[0]!.name, "ai-code-planner");
  assert.equal(modulesForCommand("run")[0]!.name, "ai-code-worker");
  assert.equal(modulesForCommand("resume")[0]!.name, "ai-code-worker");
  assert.equal(modulesForCommand("review")[0]!.name, "ai-code-review");
  assert.equal(modulesForCommand("docs")[0]!.name, "ai-code-docs");
});

test("moduleSubcommand maps root verbs onto each module's own verb", () => {
  const worker = MODULE_REGISTRY.find((module) => module.name === "ai-code-worker")!;
  assert.equal(moduleSubcommand(worker, "run"), "run");
  assert.equal(moduleSubcommand(worker, "resume"), "run");
  assert.equal(moduleSubcommand(worker, "doctor"), "doctor");

  const planner = MODULE_REGISTRY.find((module) => module.name === "ai-code-planner")!;
  assert.equal(moduleSubcommand(planner, "plan"), "propose");

  const review = MODULE_REGISTRY.find((module) => module.name === "ai-code-review")!;
  assert.equal(moduleSubcommand(review, "review"), "run");

  const docs = MODULE_REGISTRY.find((module) => module.name === "ai-code-docs")!;
  assert.equal(moduleSubcommand(docs, "docs"), "generate");
});

test("moduleSubcommand throws for a module/command pair the registry does not declare", () => {
  const planner = MODULE_REGISTRY.find((module) => module.name === "ai-code-planner")!;
  assert.throws(() => moduleSubcommand(planner, "docs"), /does not back root command 'docs'/);
});

test("every registered module declares a non-empty built CLI path", () => {
  for (const module of MODULE_REGISTRY) {
    assert.ok(module.cliRelativePath.length > 0, module.name);
    assert.match(module.cliRelativePath, /dist[\\/]src[\\/]cli\.js$/, module.name);
  }
});
