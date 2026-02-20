/**
 * Lightweight template engine for system prompt rendering.
 *
 * Supports two constructs:
 * - {{variable}} — substitutes the value from vars, or empty string if missing
 * - {{#if variable}}...{{else}}...{{/if}} — conditional block (truthy = non-empty string)
 *   The {{else}} branch is optional.
 *
 * No nested conditionals. No library dependencies.
 */

/**
 * Render a template string with variable substitution and conditionals.
 *
 * @param template - Template string with {{variable}} and {{#if}} blocks
 * @param vars - Key-value pairs for substitution (values are strings)
 * @returns Rendered string
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  // 1. Process {{#if variable}}...{{else}}...{{/if}} blocks
  let result = template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, body: string) => {
      const isTruthy = (vars[varName] ?? "").length > 0;
      const parts = body.split("{{else}}");
      const ifBranch = parts[0];
      const elseBranch = parts.length > 1 ? parts[1] : "";
      return isTruthy ? ifBranch : elseBranch;
    },
  );

  // 2. Process {{variable}} substitutions
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    return vars[varName] ?? "";
  });

  return result;
}
