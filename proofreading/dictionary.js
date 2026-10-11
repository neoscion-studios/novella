'use strict';

const MAX_DICTIONARY_ENTRY_LENGTH = 80;
const MAX_DICTIONARY_ENTRIES_PER_SCOPE = 500;
const ENTRY_PATTERN = /^\p{L}(?:[\p{L}\p{M}'’\-]*[\p{L}\p{M}])?$/u;

function dictionaryError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeDictionaryEntry(value) {
  if (typeof value !== 'string') throw dictionaryError('Dictionary entry must be a word.');
  const entry = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!entry || Array.from(entry).length > MAX_DICTIONARY_ENTRY_LENGTH || !ENTRY_PATTERN.test(entry)) {
    throw dictionaryError(`Dictionary entries must be single words of up to ${MAX_DICTIONARY_ENTRY_LENGTH} letters; apostrophes and hyphens are allowed.`);
  }
  return { entry, normalized: entry.toLocaleLowerCase('en-US').normalize('NFC') };
}

function filterDictionaryIssues(issues, entries) {
  const normalizedEntries = entries instanceof Set ? entries : new Set(entries);
  return issues.filter((issue) => {
    if (issue?.category !== 'spelling' || typeof issue.original !== 'string') return true;
    try {
      return !normalizedEntries.has(normalizeDictionaryEntry(issue.original).normalized);
    } catch {
      return true;
    }
  });
}

module.exports = {
  MAX_DICTIONARY_ENTRIES_PER_SCOPE,
  MAX_DICTIONARY_ENTRY_LENGTH,
  filterDictionaryIssues,
  normalizeDictionaryEntry
};
