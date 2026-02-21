import { describe, expect, test } from "bun:test";
import {
  convertMarkdownToTelegram,
  escapeMarkdownV2Code,
  escapeMarkdownV2LinkUrl,
  escapeMarkdownV2Text,
  formatForTelegram,
} from "../src/telegram-format";

describe("escapeMarkdownV2Text", () => {
  test("escapes all special characters", () => {
    expect(escapeMarkdownV2Text("hello_world")).toBe("hello\\_world");
    expect(escapeMarkdownV2Text("bold*text")).toBe("bold\\*text");
    expect(escapeMarkdownV2Text("[link]")).toBe("\\[link\\]");
    expect(escapeMarkdownV2Text("(paren)")).toBe("\\(paren\\)");
    expect(escapeMarkdownV2Text("text~strike")).toBe("text\\~strike");
    expect(escapeMarkdownV2Text("code`block")).toBe("code\\`block");
    expect(escapeMarkdownV2Text(">quote")).toBe("\\>quote");
    expect(escapeMarkdownV2Text("#heading")).toBe("\\#heading");
    expect(escapeMarkdownV2Text("+plus")).toBe("\\+plus");
    expect(escapeMarkdownV2Text("-dash")).toBe("\\-dash");
    expect(escapeMarkdownV2Text("=equals")).toBe("\\=equals");
    expect(escapeMarkdownV2Text("|pipe")).toBe("\\|pipe");
    expect(escapeMarkdownV2Text("{brace}")).toBe("\\{brace\\}");
    expect(escapeMarkdownV2Text("dot.")).toBe("dot\\.");
    expect(escapeMarkdownV2Text("exclaim!")).toBe("exclaim\\!");
    expect(escapeMarkdownV2Text("back\\slash")).toBe("back\\\\slash");
  });

  test("escapes multiple special chars in one string", () => {
    expect(escapeMarkdownV2Text("Hello_World! How are you?")).toBe(
      "Hello\\_World\\! How are you?",
    );
  });

  test("escapes plain underscore-delimited text", () => {
    expect(escapeMarkdownV2Text("foo_bar_baz")).toBe("foo\\_bar\\_baz");
    expect(escapeMarkdownV2Text("_existing_")).toBe("\\_existing\\_");
    expect(escapeMarkdownV2Text("file_name.py")).toBe("file\\_name\\.py");
  });
});

describe("escapeMarkdownV2Code", () => {
  test("escapes backslash and backtick only", () => {
    expect(escapeMarkdownV2Code("code\\text")).toBe("code\\\\text");
    expect(escapeMarkdownV2Code("code`text")).toBe("code\\`text");
    expect(escapeMarkdownV2Code("code_text")).toBe("code_text");
  });
});

describe("escapeMarkdownV2LinkUrl", () => {
  test("escapes parentheses and backslash", () => {
    expect(escapeMarkdownV2LinkUrl("http://example.com")).toBe(
      "http://example.com",
    );
    expect(escapeMarkdownV2LinkUrl("http://example.com/path(1)")).toBe(
      "http://example.com/path\\(1\\)",
    );
  });

  test("escapes ? and = for tg:// URLs", () => {
    expect(escapeMarkdownV2LinkUrl("tg://resolve?domain=test")).toBe(
      "tg://resolve\\?domain\\=test",
    );
  });
});

describe("convertMarkdownToTelegram", () => {
  test("converts bold from ** to *", () => {
    expect(convertMarkdownToTelegram("**bold text**")).toBe("*bold text*");
  });

  test("converts italic from * to _", () => {
    expect(convertMarkdownToTelegram("*italic text*")).toBe("_italic text_");
  });

  test("converts strikethrough from ~~ to ~", () => {
    expect(convertMarkdownToTelegram("~~strike~~")).toBe("~strike~");
  });

  test("converts headings to bold", () => {
    expect(convertMarkdownToTelegram("# Heading")).toBe("*Heading*");
    expect(convertMarkdownToTelegram("## Subheading")).toBe("*Subheading*");
  });

  test("converts list markers to bullets", () => {
    expect(convertMarkdownToTelegram("- item")).toBe("• item");
    expect(convertMarkdownToTelegram("* item")).toBe("• item");
    expect(convertMarkdownToTelegram("+ item")).toBe("• item");
  });

  test("preserves inline code with escaping", () => {
    const result = convertMarkdownToTelegram("Use `code` here");
    expect(result).toBe("Use `code` here");
  });

  test("preserves code blocks with escaping", () => {
    const result = convertMarkdownToTelegram("```\ncode\n```");
    expect(result).toBe("```\ncode\n```");
  });

  test("escapes special chars in plain text", () => {
    expect(convertMarkdownToTelegram("Price: $10.99!")).toBe(
      "Price: $10\\.99\\!",
    );
  });

  test("escapes snake_case and existing underscore pairs in plain text", () => {
    expect(convertMarkdownToTelegram("foo_bar_baz")).toBe("foo\\_bar\\_baz");
    expect(convertMarkdownToTelegram("_existing_")).toBe("\\_existing\\_");
    expect(convertMarkdownToTelegram("file_name.py")).toBe("file\\_name\\.py");
  });

  test("handles mixed content", () => {
    const input = "# Title\n\n**bold** and *italic* with `code`";
    const result = convertMarkdownToTelegram(input);
    expect(result).toContain("*Title*");
    expect(result).toContain("*bold*");
    expect(result).toContain("_italic_");
    expect(result).toContain("`code`");
  });

  test("preserves explicit markdown and escapes plain underscores in mixed text", () => {
    const result = convertMarkdownToTelegram("**bold** and snake_case");
    expect(result).toBe("*bold* and snake\\_case");
  });

  test("handles links", () => {
    const result = convertMarkdownToTelegram("[example](http://example.com)");
    expect(result).toContain("[example]");
    expect(result).toContain("http://example.com");
  });
});

describe("formatForTelegram", () => {
  test("is an alias for convertMarkdownToTelegram", () => {
    const input = "**bold** text";
    expect(formatForTelegram(input)).toBe(convertMarkdownToTelegram(input));
  });
});
