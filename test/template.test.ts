import { describe, expect, test } from "bun:test";
import { renderTemplate } from "../src/template";

describe("renderTemplate", () => {
  test("substitutes a single variable", () => {
    expect(renderTemplate("Hello {{name}}", { name: "Wilson" })).toBe(
      "Hello Wilson",
    );
  });

  test("substitutes multiple variables", () => {
    expect(
      renderTemplate("{{greeting}} {{name}}!", {
        greeting: "Hi",
        name: "Wilson",
      }),
    ).toBe("Hi Wilson!");
  });

  test("replaces missing variable with empty string", () => {
    expect(renderTemplate("Hello {{name}}", {})).toBe("Hello ");
  });

  test("replaces variable with empty value as empty string", () => {
    expect(renderTemplate("Hello {{name}}", { name: "" })).toBe("Hello ");
  });

  test("passes through template with no placeholders", () => {
    expect(renderTemplate("No placeholders here.", {})).toBe(
      "No placeholders here.",
    );
  });

  test("renders if-branch when variable is truthy", () => {
    const tpl = "{{#if tools}}Tools: {{tools}}{{/if}}";
    expect(renderTemplate(tpl, { tools: "a, b" })).toBe("Tools: a, b");
  });

  test("renders else-branch when variable is falsy", () => {
    const tpl = "{{#if tools}}Has tools{{else}}No tools{{/if}}";
    expect(renderTemplate(tpl, { tools: "" })).toBe("No tools");
  });

  test("renders else-branch when variable is missing", () => {
    const tpl = "{{#if tools}}Has tools{{else}}No tools{{/if}}";
    expect(renderTemplate(tpl, {})).toBe("No tools");
  });

  test("renders if-branch without else when truthy", () => {
    const tpl = "Start. {{#if name}}Hi {{name}}.{{/if}} End.";
    expect(renderTemplate(tpl, { name: "Suyash" })).toBe(
      "Start. Hi Suyash. End.",
    );
  });

  test("renders empty when if-branch without else is falsy", () => {
    const tpl = "Start. {{#if name}}Hi {{name}}.{{/if}} End.";
    expect(renderTemplate(tpl, {})).toBe("Start.  End.");
  });

  test("handles multiline template with conditionals", () => {
    const tpl = [
      "You are an assistant.",
      "",
      "{{#if toolNames}}",
      "Tools: {{toolNames}}.",
      "{{else}}",
      "No tools available.",
      "{{/if}}",
      "",
      "Be concise.",
    ].join("\n");

    const withTools = renderTemplate(tpl, { toolNames: "calendar, schedule" });
    expect(withTools).toContain("Tools: calendar, schedule.");
    expect(withTools).not.toContain("No tools available.");

    const noTools = renderTemplate(tpl, { toolNames: "" });
    expect(noTools).toContain("No tools available.");
    expect(noTools).not.toContain("Tools:");
  });

  test("substitutes variables inside conditional blocks", () => {
    const tpl = "{{#if toolNames}}Use {{toolNames}} wisely.{{/if}}";
    expect(renderTemplate(tpl, { toolNames: "echo" })).toBe("Use echo wisely.");
  });
});
