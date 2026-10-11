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

  return { applyReplacement, canApply, responseMatches, reviewMatches };
});
