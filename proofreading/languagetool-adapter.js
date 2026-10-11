'use strict';

const { createHash } = require('node:crypto');
const { mapProjectionSpan, projectMarkdown } = require('./markdown-projection');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REPLACEMENTS = 8;
const MAX_ISSUES = 500;
const MAX_QUEUED = 16;

function categoryFor(match) {
  const type = String(match?.rule?.issueType || match?.rule?.category?.id || '').toLowerCase();
  if (type.includes('misspell') || type.includes('typo')) return 'spelling';
  if (type.includes('grammar')) return 'grammar';
  if (type.includes('style')) return 'style';
  if (type.includes('punct')) return 'punctuation';
  return 'other';
}

function normalizeMatches(payload, source, projection) {
  if (!payload || !Array.isArray(payload.matches)) throw new Error('Malformed proofreading response.');
  return payload.matches.slice(0, MAX_ISSUES).flatMap((match, index) => {
    const span = mapProjectionSpan(projection, match?.offset, match?.length, source);
    if (!span || typeof match?.message !== 'string') return [];
    const ruleId = typeof match.rule?.id === 'string' ? match.rule.id.slice(0, 100) : undefined;
    const replacements = span.applicable && Array.isArray(match.replacements)
      ? match.replacements.slice(0, MAX_REPLACEMENTS).flatMap((item) => (
        typeof item?.value === 'string' && item.value.length <= 500 ? [{ value: item.value }] : []
      ))
      : [];
    const key = `${index}\0${ruleId || ''}\0${span.start}\0${span.end}\0${match.message}`;
    return [{
      id: createHash('sha256').update(key).digest('hex').slice(0, 20),
      category: categoryFor(match),
      message: match.message.slice(0, 1000),
      ...(typeof match.shortMessage === 'string' && match.shortMessage ? { shortMessage: match.shortMessage.slice(0, 300) } : {}),
      start: span.start,
      end: span.end,
      original: span.original,
      replacements,
      ...(ruleId ? { ruleId } : {}),
      provider: 'languagetool',
      applicable: span.applicable
    }];
  });
}

function createLanguageToolAdapter({ url, fetchImpl = globalThis.fetch, timeoutMs = 8000, maxConcurrent = 2 } = {}) {
  const endpoint = new URL('/v2/check', url).toString();
  let active = 0;
  const waiting = [];
  const acquire = () => active < maxConcurrent
    ? (active += 1, Promise.resolve())
    : waiting.length >= MAX_QUEUED
      ? Promise.reject(new Error('Proofreading is busy.'))
      : new Promise((resolve) => waiting.push(resolve));
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  return {
    async check({ text, language }) {
      const projection = projectMarkdown(text);
      if (!projection.text.trim()) return [];
      await acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ text: projection.text, language }).toString()
        });
        if (!response.ok) throw new Error('Proofreading provider failed.');
        const declaredSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) throw new Error('Proofreading response is too large.');
        const bytes = await readLimitedBody(response, MAX_RESPONSE_BYTES);
        return normalizeMatches(JSON.parse(bytes.toString('utf8')), text, projection);
      } finally {
        clearTimeout(timer);
        release();
      }
    }
  };
}

async function readLimitedBody(response, limit) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('Proofreading response is too large.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Proofreading response is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

module.exports = { createLanguageToolAdapter, normalizeMatches };
