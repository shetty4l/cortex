const SPECIAL_CHARS_TEXT = /[\\_*[\]()~`>#+=|{}.!-]/g;
const SPECIAL_CHARS_CODE = /[\\`]/g;
const SPECIAL_CHARS_LINK_URL = /[\\)(]/g;
const PLACEHOLDER_PREFIX = "\u0000TGMD";
const PLACEHOLDER_SUFFIX = "\u0000";

export function escapeMarkdownV2Text(text: string): string {
  return text.replace(SPECIAL_CHARS_TEXT, "\\$&");
}

export function escapeMarkdownV2Code(text: string): string {
  return text.replace(SPECIAL_CHARS_CODE, "\\$&");
}

export function escapeMarkdownV2LinkUrl(url: string): string {
  let escaped = url.replace(SPECIAL_CHARS_LINK_URL, "\\$&");
  if (url.startsWith("tg://")) {
    escaped = escaped.replace(/[?=]/g, "\\$&");
  }
  return escaped;
}

function protectPattern(
  input: string,
  pattern: RegExp,
  slots: string[],
  render: (...groups: string[]) => string,
): string {
  return input.replace(pattern, (_match, ...groups) => {
    const slotValue = render(...(groups.slice(0, -2) as string[]));
    const index = slots.push(slotValue) - 1;
    return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
  });
}

function restorePlaceholders(input: string, slots: string[]): string {
  const pattern = new RegExp(
    `${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`,
    "g",
  );
  return input.replace(pattern, (_match, idx) => {
    const index = Number.parseInt(idx, 10);
    return slots[index] ?? "";
  });
}

function convertLine(line: string): string {
  let working = line;
  let bulletPrefix = false;

  const heading = working.match(/^#{1,6}\s+(.+)$/);
  if (heading) {
    working = `**${heading[1]}**`;
  }

  const listItem = working.match(/^[-*+]\s+(.+)$/);
  if (listItem) {
    bulletPrefix = true;
    working = listItem[1];
  }

  const slots: string[] = [];

  working = protectPattern(working, /`([^`\n]+)`/g, slots, (code) => {
    return `\`${escapeMarkdownV2Code(code)}\``;
  });

  working = protectPattern(
    working,
    /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    slots,
    (text, url) => {
      return `[${escapeMarkdownV2Text(text)}](${escapeMarkdownV2LinkUrl(url)})`;
    },
  );

  working = protectPattern(working, /\*\*([^*\n]+?)\*\*/g, slots, (text) => {
    return `*${escapeMarkdownV2Text(text)}*`;
  });

  working = protectPattern(working, /\*([^*\n]+?)\*/g, slots, (text) => {
    return `_${escapeMarkdownV2Text(text)}_`;
  });

  working = protectPattern(working, /~~([^~\n]+?)~~/g, slots, (text) => {
    return `~${escapeMarkdownV2Text(text)}~`;
  });

  const escaped = escapeMarkdownV2Text(working);
  const restored = restorePlaceholders(escaped, slots);
  return bulletPrefix ? `• ${restored}` : restored;
}

export function convertMarkdownToTelegram(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(escapeMarkdownV2Code(line));
      continue;
    }

    result.push(convertLine(line));
  }

  return result.join("\n");
}

export function formatForTelegram(markdown: string): string {
  return convertMarkdownToTelegram(markdown);
}
