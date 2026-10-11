'use strict';

// LanguageTool reports Java/JavaScript-style UTF-16 offsets. This projection keeps
// one source offset for every UTF-16 code unit that survives Markdown stripping.
function projectMarkdown(source) {
  source = typeof source === 'string' ? source : '';
  const output = [];
  const sourceOffsets = [];
  let fenced = null;

  const appendRange = (start, end, afterSkippedSyntax = false) => {
    for (let index = start; index < end; index += 1) {
      if (
        afterSkippedSyntax && index === start
        && /[ \t]/.test(source[index])
        && /[ \t]/.test(output.at(-1) || '')
      ) continue;
      output.push(source[index]);
      sourceOffsets.push(index);
    }
  };

  let lineStart = 0;
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fenced) fenced = { character: marker[0], length: marker.length };
      else if (marker[0] === fenced.character && marker.length >= fenced.length) fenced = null;
      if (newline !== -1) {
        output.push('\n');
        sourceOffsets.push(newline);
      }
      lineStart = newline === -1 ? source.length + 1 : newline + 1;
      continue;
    }

    if (!fenced) projectLine(source, lineStart, lineEnd, appendRange);
    if (newline !== -1) {
      output.push('\n');
      sourceOffsets.push(newline);
    }
    lineStart = newline === -1 ? source.length + 1 : newline + 1;
  }

  return { text: output.join(''), sourceOffsets };
}

function projectLine(source, start, end, appendRange) {
  let cursor = start;
  let skippedSyntax = false;
  const prefix = source.slice(start, end).match(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/);
  if (prefix) {
    const whitespace = prefix[0].match(/^\s*/)[0].length;
    if (whitespace) appendRange(start, start + whitespace);
    cursor = start + prefix[0].length;
  }

  while (cursor < end) {
    const rest = source.slice(cursor, end);
    const inlineCode = rest.match(/^(`+)([\s\S]*?)\1/);
    if (inlineCode) {
      cursor += inlineCode[0].length;
      skippedSyntax = true;
      continue;
    }
    const imageOrLink = rest.match(/^!?\[([^\]]*)\]\((?:\\.|[^)])*\)/);
    if (imageOrLink) {
      if (!rest.startsWith('!')) {
        const labelStart = cursor + 1;
        appendRange(labelStart, labelStart + imageOrLink[1].length);
      }
      cursor += imageOrLink[0].length;
      skippedSyntax = true;
      continue;
    }
    const autolink = rest.match(/^<(?:(?:https?:\/\/|mailto:)[^>]+|[^ <>@]+@[^ <>@]+)>/i);
    if (autolink) {
      cursor += autolink[0].length;
      skippedSyntax = true;
      continue;
    }
    const bareUrl = rest.match(/^(?:https?:\/\/|www\.)[^\s<]+/i);
    if (bareUrl) {
      cursor += bareUrl[0].length;
      skippedSyntax = true;
      continue;
    }
    const html = rest.match(/^<\/?[A-Za-z][^>]*>/);
    if (html) {
      cursor += html[0].length;
      skippedSyntax = true;
      continue;
    }
    const delimiter = rest.match(/^(?:\*\*|__|~~|[*_])/);
    if (delimiter) {
      cursor += delimiter[0].length;
      skippedSyntax = true;
      continue;
    }
    if (source[cursor] === '\\' && cursor + 1 < end && /[\\`*{}[\]()#+.!_>~-]/.test(source[cursor + 1])) {
      appendRange(cursor + 1, cursor + 2);
      cursor += 2;
      skippedSyntax = false;
      continue;
    }
    appendRange(cursor, cursor + 1, skippedSyntax);
    skippedSyntax = false;
    cursor += 1;
  }
}

function mapProjectionSpan(projection, offset, length, source) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) return null;
  if (offset < 0 || offset + length > projection.text.length) return null;
  const mapped = projection.sourceOffsets.slice(offset, offset + length);
  if (mapped.length !== length || mapped.some((value) => !Number.isInteger(value))) return null;
  const start = mapped[0];
  const end = mapped[mapped.length - 1] + 1;
  const contiguous = mapped.every((value, index) => index === 0 || value === mapped[index - 1] + 1);
  if (start < 0 || end > source.length || start >= end) return null;
  return { start, end, original: source.slice(start, end), applicable: contiguous };
}

module.exports = { mapProjectionSpan, projectMarkdown };
