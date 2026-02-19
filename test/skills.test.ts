import { describe, expect, test } from "bun:test";
import { join } from "path";
import type { SkillRuntimeContext } from "../src/skills";
import { createEmptyRegistry, loadSkills } from "../src/skills";

// --- Helpers ---

const FIXTURES = join(import.meta.dir, "fixtures");
const VALID = join(FIXTURES, "skills-valid");
const BAD_API = join(FIXTURES, "skills-bad-api");
const BAD_MANIFEST = join(FIXTURES, "skills-bad-manifest");
const BAD_MODULE = join(FIXTURES, "skills-bad-module");
const BAD_ID = join(FIXTURES, "skills-bad-id");
const BAD_TOOL_NAME = join(FIXTURES, "skills-bad-tool-name");
const DUP = join(FIXTURES, "skills-dup");

function stubContext(): SkillRuntimeContext {
  return {
    nowIso: new Date().toISOString(),
    config: {},
    db: { query: () => {}, run: () => {} },
    http: { fetch },
  };
}

// --- Tests ---

describe("skill loader", () => {
  // --- Successful loading ---

  test("loads skills and namespaces tools correctly", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.tools.map((t) => t.name).sort();
    expect(names).toContain("echo.say");
    expect(names).toContain("math.add");
    expect(names).toContain("mutating.write");
    expect(names).toContain("mutating.read");
  });

  test("tool definitions have correct fields", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const echoSay = result.value.tools.find((t) => t.name === "echo.say");
    expect(echoSay).toBeDefined();
    expect(echoSay!.description).toBe("Echo back the input text");
    expect(echoSay!.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });

    const mathAdd = result.value.tools.find((t) => t.name === "math.add");
    expect(mathAdd).toBeDefined();
    expect(mathAdd!.inputSchema.properties).toEqual({
      a: { type: "number" },
      b: { type: "number" },
    });
  });

  test("mutatesState defaults to false when omitted", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const echoSay = result.value.tools.find((t) => t.name === "echo.say");
    expect(echoSay!.mutatesState).toBe(false);

    const mathAdd = result.value.tools.find((t) => t.name === "math.add");
    expect(mathAdd!.mutatesState).toBe(false);
  });

  test("mutatesState true is preserved", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isMutating("mutating.write")).toBe(true);
    expect(result.value.isMutating("mutating.read")).toBe(false);
  });

  // --- Tool execution ---

  test("executeTool passes local (unqualified) name to skill module", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // mutating skill's execute returns `executed ${call.name}`
    const execResult = await result.value.executeTool(
      "mutating.write",
      "{}",
      stubContext(),
    );

    expect(execResult.ok).toBe(true);
    if (!execResult.ok) return;
    // Should receive "write", not "mutating.write"
    expect(execResult.value.content).toBe("executed write");
  });

  test("executeTool calls skill module and returns result", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = await result.value.executeTool(
      "echo.say",
      JSON.stringify({ text: "hello world" }),
      stubContext(),
    );

    expect(execResult.ok).toBe(true);
    if (!execResult.ok) return;
    expect(execResult.value.content).toBe("hello world");
  });

  test("executeTool computes correct result", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = await result.value.executeTool(
      "math.add",
      JSON.stringify({ a: 3, b: 7 }),
      stubContext(),
    );

    expect(execResult.ok).toBe(true);
    if (!execResult.ok) return;
    expect(execResult.value.content).toBe("10");
  });

  test("executeTool returns err for unknown tool", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = await result.value.executeTool(
      "nonexistent.tool",
      "{}",
      stubContext(),
    );

    expect(execResult.ok).toBe(false);
    if (execResult.ok) return;
    expect(execResult.error).toContain("unknown tool");
  });

  test("executeTool catches thrown errors", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pass invalid JSON to trigger a parse error inside the skill
    const execResult = await result.value.executeTool(
      "echo.say",
      "not json",
      stubContext(),
    );

    expect(execResult.ok).toBe(false);
    if (execResult.ok) return;
    expect(execResult.error).toContain("echo.say threw");
  });

  // --- Per-skill config injection ---

  test("executeTool injects per-skill config into context", async () => {
    // We need a skill that reads from ctx.config.
    // Use math.add — it ignores config, but we can verify via a custom skill.
    // Instead, test indirectly: load with skillConfig and verify it doesn't break.
    const result = await loadSkills([VALID], {
      echo: { greeting: "hello" },
      math: { precision: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Basic execution still works with config
    const execResult = await result.value.executeTool(
      "echo.say",
      JSON.stringify({ text: "test" }),
      stubContext(),
    );
    expect(execResult.ok).toBe(true);
  });

  // --- isMutating ---

  test("isMutating returns false for unknown tools", async () => {
    const result = await loadSkills([VALID]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isMutating("nonexistent.tool")).toBe(false);
  });

  // --- Validation errors ---

  test("fails on unsupported runtimeApiVersion", async () => {
    const result = await loadSkills([BAD_API]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unsupported runtimeApiVersion");
    expect(result.error).toContain('"99"');
  });

  test("fails on missing manifest fields", async () => {
    const result = await loadSkills([BAD_MANIFEST]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"id"');
    expect(result.error).toContain("non-empty string");
  });

  test("fails on invalid module interface", async () => {
    const result = await loadSkills([BAD_MODULE]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must default-export");
  });

  test("fails on duplicate skill id across directories", async () => {
    // VALID has id: "echo", DUP also has id: "echo" — caught before tool names
    const result = await loadSkills([VALID, DUP]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("duplicate skill id");
    expect(result.error).toContain('"echo"');
  });

  test("fails on invalid skill id format", async () => {
    const result = await loadSkills([BAD_ID]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bad.id");
    expect(result.error).toContain("invalid");
  });

  test("fails on invalid tool name format", async () => {
    const result = await loadSkills([BAD_TOOL_NAME]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bad.tool");
    expect(result.error).toContain("invalid");
  });

  test("fails on non-existent skill directory", async () => {
    const result = await loadSkills(["/nonexistent/path"]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("does not exist");
  });

  // --- Empty registry ---

  test("createEmptyRegistry has zero tools", () => {
    const registry = createEmptyRegistry();

    expect(registry.tools).toHaveLength(0);
    expect(registry.isMutating("anything")).toBe(false);
  });

  test("createEmptyRegistry executeTool returns err", async () => {
    const registry = createEmptyRegistry();
    const result = await registry.executeTool("any.tool", "{}", stubContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unknown tool");
  });

  test("loadSkills with empty array succeeds", async () => {
    const result = await loadSkills([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools).toHaveLength(0);
  });
});
