(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NovellaProofreading = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  function reviewMatches(review, novelId, sceneId, text) {
    return Boolean(review && review.novelId === novelId && review.sceneId === sceneId && review.snapshot === text);
  }

  function responseMatches(requestSerial, currentSerial, requestNovelId, currentNovelId) {
    return requestSerial === currentSerial && requestNovelId === currentNovelId;
  }

  function dictionaryWord(issue) {
    if (issue?.category !== 'spelling' || typeof issue.original !== 'string') return null;
    const entry = issue.original.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!entry || Array.from(entry).length > 80 || !/^\p{L}(?:[\p{L}\p{M}'’\-]*[\p{L}\p{M}])?$/u.test(entry)) return null;
    return entry;
  }

  function adjacentIssue(reviews, selected, direction) {
    const issues = reviews.flatMap((review) => review.issues.map((issue) => ({ sceneId: review.sceneId, issueId: issue.id })));
    if (!issues.length) return null;
    const current = issues.findIndex((item) => item.sceneId === selected?.sceneId && item.issueId === selected?.issueId);
    const next = current < 0
      ? (direction > 0 ? 0 : issues.length - 1)
      : (current + direction + issues.length) % issues.length;
    return issues[next];
  }

  async function runSequential(items, worker, shouldStop = () => false, onProgress = () => {}) {
    let completed = 0;
    for (const item of items) {
      const result = await worker(item);
      completed += 1;
      onProgress(completed, items.length, result);
      if (shouldStop(result)) break;
    }
    return completed;
  }

  function canApply(review, issue, novelId, sceneId, text) {
    return reviewMatches(review, novelId, sceneId, text)
      && issue?.applicable !== false
      && Number.isInteger(issue?.start)
      && Number.isInteger(issue?.end)
      && issue.start >= 0
      && issue.end > issue.start
      && issue.end <= text.length
      && text.slice(issue.start, issue.end) === issue.original;
  }

  function applyReplacement(textarea, review, issue, replacement, novelId, sceneId) {
    if (!textarea || typeof replacement !== 'string' || !canApply(review, issue, novelId, sceneId, textarea.value)) return false;
    textarea.focus();
    textarea.setSelectionRange(issue.start, issue.end);
    textarea.setRangeText(replacement, issue.start, issue.end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  return { adjacentIssue, applyReplacement, canApply, dictionaryWord, responseMatches, reviewMatches, runSequential };
});
