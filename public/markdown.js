(function exposeMarkdown(root, factory) {
  const markdown = factory();
  if (typeof module === 'object' && module.exports) module.exports = markdown;
  else root.NovellaMarkdown = markdown;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function escapeHtml(value = '') {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function safeLink(url) {
    const decoded = url.trim();
    return /^(https?:\/\/|mailto:|#|\/)/i.test(decoded) ? escapeHtml(decoded) : null;
  }

  function renderInline(source) {
    const tokens = [];
    const token = (html) => {
      const index = tokens.push(html) - 1;
      return `\u0000TOKEN${index}\u0000`;
    };

    let text = String(source)
      .replace(/`([^`\n]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`))
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
        const href = safeLink(url);
        if (!href) return match;
        const external = /^https?:\/\//i.test(url) ? ' target="_blank" rel="noreferrer"' : '';
        return token(`<a href="${href}"${external}>${escapeHtml(label)}</a>`);
      });

    text = escapeHtml(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

    return text.replace(/\u0000TOKEN(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  }

  function isBlockStart(line) {
    return /^\s*(```|#{1,6}\s|>\s?|[-+*]\s+|\d+\.\s+|([-*_])(?:\s*\2){2,}\s*$)/.test(line);
  }

  function renderMarkdown(source = '') {
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s*```([^\s`]*)\s*$/);
      if (fence) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
        html.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        html.push('<hr>');
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quote.push(lines[index++].replace(/^\s*>\s?/, ''));
        }
        html.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`);
        continue;
      }

      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (unordered || ordered) {
        const tag = unordered ? 'ul' : 'ol';
        const pattern = unordered ? /^\s*[-+*]\s+(.+)$/ : /^\s*\d+\.\s+(.+)$/;
        const items = [];
        while (index < lines.length) {
          const item = lines[index].match(pattern);
          if (!item) break;
          items.push(`<li>${renderInline(item[1])}</li>`);
          index += 1;
        }
        html.push(`<${tag}>${items.join('')}</${tag}>`);
        continue;
      }

      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    }

    return html.join('\n');
  }

  return { renderMarkdown, renderInline };
}));
