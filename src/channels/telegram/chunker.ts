const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

type Fragment =
  | { kind: "plain"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "inline_code"; text: string }
  | { kind: "fenced_code"; text: string }
  | { kind: "link"; text: string };

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function hasOddTrailingBackslash(text: string): boolean {
  let slashCount = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function findUnescaped(text: string, needle: string, from: number): number {
  let index = text.indexOf(needle, from);
  while (index !== -1 && isEscaped(text, index)) {
    index = text.indexOf(needle, index + 1);
  }
  return index;
}

function splitPlainText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;
    for (const boundary of ["\n\n", "\n", " "]) {
      const maxBoundaryStart = maxLength - boundary.length;
      if (maxBoundaryStart < 0) continue;
      const idx = remaining.lastIndexOf(boundary, maxBoundaryStart);
      if (idx > 0) {
        splitAt = idx + boundary.length;
        break;
      }
    }

    if (splitAt === -1) {
      splitAt = maxLength;
    }

    while (
      splitAt > 0 &&
      hasOddTrailingBackslash(remaining.slice(0, splitAt))
    ) {
      splitAt--;
    }

    if (splitAt === 0) {
      splitAt = maxLength;
      while (
        splitAt > 1 &&
        hasOddTrailingBackslash(remaining.slice(0, splitAt))
      ) {
        splitAt--;
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

function parseLink(
  text: string,
  start: number,
): { raw: string; end: number } | null {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "]" && !isEscaped(text, i)) {
      break;
    }
    i++;
  }
  if (i >= text.length || text[i + 1] !== "(") return null;

  let j = i + 2;
  while (j < text.length) {
    if (text[j] === ")" && !isEscaped(text, j)) {
      const raw = text.slice(start, j + 1);
      return { raw, end: j + 1 };
    }
    j++;
  }
  return null;
}

function tokenizeMarkdownV2(text: string): Fragment[] {
  const fragments: Fragment[] = [];
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i) && !isEscaped(text, i)) {
      const end = findUnescaped(text, "```", i + 3);
      if (end !== -1) {
        fragments.push({ kind: "fenced_code", text: text.slice(i, end + 3) });
        i = end + 3;
        continue;
      }
    }

    if (text[i] === "`" && !isEscaped(text, i)) {
      const end = findUnescaped(text, "`", i + 1);
      if (end !== -1) {
        fragments.push({ kind: "inline_code", text: text.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "[" && !isEscaped(text, i)) {
      const parsed = parseLink(text, i);
      if (parsed) {
        fragments.push({ kind: "link", text: parsed.raw });
        i = parsed.end;
        continue;
      }
    }

    if (["*", "_", "~"].includes(text[i]) && !isEscaped(text, i)) {
      const marker = text[i];
      const end = findUnescaped(text, marker, i + 1);
      if (end !== -1) {
        const raw = text.slice(i, end + 1);
        if (marker === "*") {
          fragments.push({ kind: "bold", text: raw });
        } else if (marker === "_") {
          fragments.push({ kind: "italic", text: raw });
        } else {
          fragments.push({ kind: "strike", text: raw });
        }
        i = end + 1;
        continue;
      }
    }

    const start = i;
    i++;
    while (i < text.length) {
      const startsSpecial =
        (text.startsWith("```", i) && !isEscaped(text, i)) ||
        (text[i] === "`" && !isEscaped(text, i)) ||
        (text[i] === "[" && !isEscaped(text, i)) ||
        (["*", "_", "~"].includes(text[i]) && !isEscaped(text, i));
      if (startsSpecial) break;
      i++;
    }
    fragments.push({ kind: "plain", text: text.slice(start, i) });
  }

  return fragments;
}

function splitWrappedFragment(
  text: string,
  prefix: string,
  suffix: string,
  maxLength: number,
): string[] {
  const capacity = Math.max(1, maxLength - prefix.length - suffix.length);
  return splitPlainText(text, capacity).map(
    (part) => `${prefix}${part}${suffix}`,
  );
}

function splitFragment(fragment: Fragment, maxLength: number): string[] {
  if (fragment.text.length <= maxLength) {
    return [fragment.text];
  }

  if (fragment.kind === "plain") {
    return splitPlainText(fragment.text, maxLength);
  }

  if (fragment.kind === "bold") {
    const content = fragment.text.slice(1, -1);
    return splitWrappedFragment(content, "*", "*", maxLength);
  }

  if (fragment.kind === "italic") {
    const content = fragment.text.slice(1, -1);
    return splitWrappedFragment(content, "_", "_", maxLength);
  }

  if (fragment.kind === "strike") {
    const content = fragment.text.slice(1, -1);
    return splitWrappedFragment(content, "~", "~", maxLength);
  }

  if (fragment.kind === "inline_code") {
    const content = fragment.text.slice(1, -1);
    return splitWrappedFragment(content, "`", "`", maxLength);
  }

  if (fragment.kind === "fenced_code") {
    const content = fragment.text.slice(3, -3);
    return splitWrappedFragment(content, "```", "```", maxLength);
  }

  const closeBracket = fragment.text.indexOf("](");
  if (
    fragment.kind === "link" &&
    closeBracket !== -1 &&
    fragment.text.endsWith(")")
  ) {
    const textPart = fragment.text.slice(1, closeBracket);
    const urlPart = fragment.text.slice(closeBracket + 2, -1);
    const prefix = "[";
    const middle = `](${urlPart})`;
    const capacity = Math.max(1, maxLength - prefix.length - middle.length);
    return splitPlainText(textPart, capacity).map(
      (part) => `[${part}](${urlPart})`,
    );
  }

  return splitPlainText(fragment.text, maxLength);
}

export function chunkMarkdownV2(
  convertedMarkdownV2: string,
  maxLength = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  const limit =
    Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 1;
  if (convertedMarkdownV2.length <= limit) {
    return [convertedMarkdownV2];
  }

  const fragments = tokenizeMarkdownV2(convertedMarkdownV2);
  const pieces = fragments.flatMap((fragment) =>
    splitFragment(fragment, limit),
  );

  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    if (piece.length > limit) {
      const emergencyPieces = splitPlainText(piece, limit);
      for (const emergencyPiece of emergencyPieces) {
        if (current.length > 0) {
          chunks.push(current);
          current = "";
        }
        chunks.push(emergencyPiece);
      }
      continue;
    }

    if (current.length + piece.length <= limit) {
      current += piece;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    current = piece;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
