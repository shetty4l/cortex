import { describe, expect, test } from "bun:test";
import { chunkMarkdownV2 } from "../src/telegram-chunker";
import { formatForTelegram } from "../src/telegram-format";

function hasOddTrailingBackslash(text: string): boolean {
  let slashCount = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

describe("chunkMarkdownV2", () => {
  test("keeps every chunk at or below 4096", () => {
    const input = `${"line ".repeat(3000)}\n\n${"next ".repeat(3000)}`;
    const chunks = chunkMarkdownV2(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe(input);
  });

  test("does not end chunks with odd trailing backslash", () => {
    const input = `${"a".repeat(4095)}\\_tail`;
    const chunks = chunkMarkdownV2(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => hasOddTrailingBackslash(chunk))).toBe(false);
    expect(chunks.join("")).toBe(input);
  });

  test("splits long bold content into valid bold fragments", () => {
    const input = `*${"boldtext ".repeat(900)}*`;
    const chunks = chunkMarkdownV2(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("*"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("*"))).toBe(true);
  });

  test("splits long links without exceeding limit", () => {
    const input = `[${"linktext ".repeat(1000)}](https://example.com/path)`;
    const chunks = chunkMarkdownV2(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("["))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith(")"))).toBe(true);
  });

  test("splits long fenced code blocks into fenced chunks", () => {
    const input = `\`\`\`\n${"code line\n".repeat(1000)}\`\`\``;
    const chunks = chunkMarkdownV2(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("```"))).toBe(true);
  });

  test("is deterministic for the same input", () => {
    const input = formatForTelegram(
      `${"header\n".repeat(100)}\n**bold** and _escaped_ and [x](https://example.com)`,
    );
    const first = chunkMarkdownV2(input);
    const second = chunkMarkdownV2(input);
    expect(second).toEqual(first);
  });
});
