const app = document.querySelector('#app');
const saveStatus = document.querySelector('#saveStatus');
const authInfo = document.querySelector('#authInfo');
const authUser = document.querySelector('#authUser');
const csrfToken = document.querySelector('#csrfToken');
const toast = document.querySelector('#toast');
const confirmDialog = document.querySelector('#confirmDialog');
const importDialog = document.querySelector('#importDialog');
const importSummary = document.querySelector('#importSummary');
const projectImportFile = document.querySelector('#projectImportFile');
const PROJECT_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

let project = null;
let currentView = 'manuscript';
let activeSceneId = null;
let saveTimer = null;
let savePromise = Promise.resolve();
let draggedItem = null;
let editorMode = 'write';
let novels = [];
let activeNovelId = null;
let ttsConfig = { enabled: false, modelId: '', maxCharacters: 0 };
let narration = { sceneId: null, state: 'idle', audio: null, objectUrl: null, controller: null };
let proofreadingConfig = { enabled: false, language: 'en-US', maxTextLength: 100000 };
let proofreading = {
  requestSerial: 0,
  running: false,
  mode: 'scene',
  novelId: null,
  chapterId: null,
  status: 'idle',
  reviews: new Map(),
  selected: null,
  progress: { completed: 0, total: 0 }
};
let dictionaries = { novelId: null, author: [], novel: [], open: false, loading: false, loaded: false, error: '' };

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const countWords = (value = '') => {
  const text = value.trim();
  return text ? text.split(/\s+/).length : 0;
};

const pluralize = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function findScene(sceneId = activeSceneId) {
  for (const chapter of project.chapters) {
    const scene = chapter.scenes.find((item) => item.id === sceneId);
    if (scene) return { chapter, scene };
  }
  return null;
}

function firstSceneId() {
  return project.chapters.flatMap((chapter) => chapter.scenes)[0]?.id ?? null;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function setSaveStatus(status, label) {
  saveStatus.className = `save-status ${status}`;
  saveStatus.innerHTML = `<span class="status-dot"></span> ${label}`;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveStatus('saving', 'Saving…');
  saveTimer = setTimeout(saveNow, 550);
}

function saveNow() {
  if (!project || !activeNovelId) return Promise.resolve(true);
  clearTimeout(saveTimer);
  saveTimer = null;
  setSaveStatus('saving', 'Saving…');
  const snapshot = JSON.stringify(project);
  const novelId = activeNovelId;
  savePromise = savePromise.then(async () => {
    const response = await fetch(`/api/novels/${encodeURIComponent(novelId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: snapshot
    });
    if (!response.ok) throw new Error('Save failed');
    setSaveStatus('', 'Saved');
    return true;
  }).catch(() => {
    setSaveStatus('error', 'Not saved');
    showToast('Could not save. Your edits remain in this window.');
    return false;
  });
  return savePromise;
}

function narrationButtonMarkup(scene) {
  const state = narration.sceneId === scene.id ? narration.state : 'idle';
  const labels = { loading: 'Preparing…', playing: 'Pause', paused: 'Resume', ready: 'Replay', idle: 'Listen' };
  const icons = { loading: '◌', playing: 'Ⅱ', paused: '▶', ready: '↻', idle: '▶' };
  const disabled = !ttsConfig.enabled || !scene.content.trim();
  const title = !ttsConfig.enabled
    ? 'Configure ElevenLabs to enable narration'
    : !scene.content.trim() ? 'Add scene text to enable narration' : 'Read this scene aloud';
  return `
    <button class="listen-button ${state}" data-listen-scene="${escapeHtml(scene.id)}" title="${title}" ${disabled ? 'disabled' : ''}>
      <span class="listen-icon" aria-hidden="true">${icons[state]}</span>
      <span data-listen-label>${labels[state]}</span>
    </button>`;
}

function updateNarrationButton(sceneId = narration.sceneId) {
  if (!sceneId) return;
  const button = document.querySelector(`[data-listen-scene="${CSS.escape(sceneId)}"]`);
  if (!button) return;
  const found = findScene(sceneId);
  const state = narration.sceneId === sceneId ? narration.state : 'idle';
  const labels = { loading: 'Preparing…', playing: 'Pause', paused: 'Resume', ready: 'Replay', idle: 'Listen' };
  const icons = { loading: '◌', playing: 'Ⅱ', paused: '▶', ready: '↻', idle: '▶' };
  button.className = `listen-button ${state}`;
  button.disabled = !ttsConfig.enabled || !found?.scene.content.trim();
  button.querySelector('[data-listen-label]').textContent = labels[state];
  button.querySelector('.listen-icon').textContent = icons[state];
}

function setNarrationState(state) {
  narration.state = state;
  updateNarrationButton();
}

function discardNarration() {
  const previousSceneId = narration.sceneId;
  narration.controller?.abort();
  if (narration.audio) {
    narration.audio.pause();
    narration.audio.removeAttribute('src');
  }
  if (narration.objectUrl) URL.revokeObjectURL(narration.objectUrl);
  narration = { sceneId: null, state: 'idle', audio: null, objectUrl: null, controller: null };
  updateNarrationButton(previousSceneId);
}

async function toggleNarration(sceneId) {
  const found = findScene(sceneId);
  if (!found?.scene.content.trim()) return showToast('Add some scene text before listening.');

  if (narration.sceneId === sceneId) {
    if (narration.state === 'loading') return discardNarration();
    if (narration.state === 'playing') {
      narration.audio.pause();
      return setNarrationState('paused');
    }
    if (narration.audio && (narration.state === 'paused' || narration.state === 'ready')) {
      try {
        await narration.audio.play();
        return setNarrationState('playing');
      } catch {
        return showToast('Your browser blocked audio playback. Press Listen again.');
      }
    }
  }

  discardNarration();
  const controller = new AbortController();
  narration = { sceneId, state: 'loading', audio: null, objectUrl: null, controller };
  updateNarrationButton();

  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: found.scene.content }),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Narration could not be generated.' }));
      throw new Error(error.error);
    }
    if (narration.controller !== controller) return;

    const objectUrl = URL.createObjectURL(await response.blob());
    const audio = new Audio(objectUrl);
    narration.audio = audio;
    narration.objectUrl = objectUrl;
    narration.controller = null;
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      setNarrationState('ready');
    });
    audio.addEventListener('error', () => {
      discardNarration();
      showToast('The generated audio could not be played.');
    });
    await audio.play();
    setNarrationState('playing');
  } catch (error) {
    if (error.name === 'AbortError') return;
    discardNarration();
    showToast(error.message || 'Narration could not be generated.');
  }
}

function novelPickerMarkup() {
  const options = novels.map((novel) => `
    <option value="${escapeHtml(novel.id)}" ${novel.id === activeNovelId ? 'selected' : ''}>${escapeHtml(novel.title || 'Untitled novel')}</option>`).join('');
  return `
    <div class="novel-picker">
      <label for="novelSwitcher">Novel library</label>
      <div class="novel-picker-row">
        <select id="novelSwitcher" data-novel-switcher aria-label="Current novel">${options}</select>
        <button class="icon-button novel-action" data-add-novel title="Create a novel" aria-label="Create a novel">＋</button>
        <button class="icon-button novel-action" data-delete-novel title="Delete this novel" aria-label="Delete this novel" ${novels.length <= 1 ? 'disabled' : ''}>×</button>
      </div>
    </div>`;
}

function chapterMarkup(chapter, chapterIndex) {
  const scenes = chapter.scenes.map((scene) => `
    <div class="scene-row ${scene.id === activeSceneId ? 'active' : ''}" data-scene-id="${escapeHtml(scene.id)}" draggable="true" tabindex="0">
      <span class="drag-handle" title="Drag scene">⠿</span>
      <span class="scene-name">${escapeHtml(scene.title || 'Untitled scene')}</span>
      <span class="scene-word-count">${countWords(scene.content)}</span>
    </div>`).join('');

  return `
    <section class="chapter-group" data-chapter-id="${escapeHtml(chapter.id)}" draggable="true">
      <div class="chapter-row">
        <span class="drag-handle" title="Drag chapter">⠿</span>
        <input class="chapter-name" aria-label="Chapter title" data-chapter-title="${escapeHtml(chapter.id)}" value="${escapeHtml(chapter.title)}" />
        <button class="icon-button small chapter-menu" data-delete-chapter="${escapeHtml(chapter.id)}" title="Delete chapter" aria-label="Delete ${escapeHtml(chapter.title)}">×</button>
      </div>
      <div class="scene-list" data-scene-list="${escapeHtml(chapter.id)}">${scenes}</div>
      <button class="add-scene" data-add-scene="${escapeHtml(chapter.id)}">＋ Add scene</button>
    </section>`;
}

function renderManuscript() {
  const active = findScene();
  app.innerHTML = `
    <div class="manuscript-layout">
      <aside class="outline">
        <div class="outline-header">
          ${novelPickerMarkup()}
          <input class="project-title-input" data-project-field="title" aria-label="Novel title" value="${escapeHtml(project.title)}" placeholder="Untitled novel" />
          <input class="author-input" data-project-field="author" aria-label="Author" value="${escapeHtml(project.author)}" placeholder="Add author name" />
        </div>
        <div class="outline-label">
          <span>Chapters</span>
          <button class="icon-button" data-add-chapter title="Add chapter" aria-label="Add chapter">＋</button>
        </div>
        <div class="outline-list">${project.chapters.map(chapterMarkup).join('')}</div>
      </aside>
      <section class="editor-area">${active ? editorMarkup(active.chapter, active.scene) : emptyEditorMarkup()}</section>
    </div>`;
  resizeTextareas();
  setEditorMode(editorMode);
}

function resetProofreading() {
  proofreading.requestSerial += 1;
  proofreading.running = false;
  proofreading.mode = 'scene';
  proofreading.novelId = activeNovelId;
  proofreading.chapterId = null;
  proofreading.status = 'idle';
  proofreading.reviews.clear();
  proofreading.selected = null;
  proofreading.progress = { completed: 0, total: 0 };
  dictionaries = { novelId: activeNovelId, author: [], novel: [], open: false, loading: false, loaded: false, error: '' };
}

function dictionaryManagerMarkup() {
  if (!dictionaries.open) return '';
  if (dictionaries.loading) return '<div class="dictionary-manager"><p class="proofreading-empty">Loading dictionaries…</p></div>';
  const list = (scope, entries) => `<section class="dictionary-scope"><h4>${scope === 'author' ? 'Author dictionary' : 'Novel dictionary'}</h4>
    ${entries.length ? `<ul>${entries.map((item) => `<li><span>${escapeHtml(item.entry)}</span><button data-dictionary-remove="${escapeHtml(item.entry)}" data-dictionary-scope="${scope}" aria-label="Remove ${escapeHtml(item.entry)} from ${scope} dictionary">Remove</button></li>`).join('')}</ul>` : '<p class="proofreading-empty">No words yet.</p>'}
  </section>`;
  return `<div class="dictionary-manager">
    <form data-dictionary-form>
      <label for="dictionaryEntry">Add a word</label>
      <div class="dictionary-form-row">
        <input id="dictionaryEntry" name="entry" maxlength="80" autocomplete="off" required placeholder="Invented word" />
        <select name="scope" aria-label="Dictionary scope"><option value="novel">This novel</option><option value="author">All my novels</option></select>
        <button type="submit">Add</button>
      </div>
      <p>Matching is case-insensitive and exact. Single words may contain letters, apostrophes, or hyphens.</p>
    </form>
    ${dictionaries.error ? `<p class="dictionary-error" role="alert">${escapeHtml(dictionaries.error)}</p>` : ''}
    <div class="dictionary-lists">${list('novel', dictionaries.novel)}${list('author', dictionaries.author)}</div>
  </div>`;
}

function proofreadingPanelMarkup() {
  const reviews = proofreading.mode === 'chapter' && proofreading.chapterId
    ? (project.chapters.find((chapter) => chapter.id === proofreading.chapterId)?.scenes || [])
      .map((scene) => proofreading.reviews.get(scene.id)).filter(Boolean)
    : [proofreading.reviews.get(activeSceneId)].filter(Boolean);
  const issueCount = reviews.reduce((sum, review) => sum + review.issues.length, 0);
  const hasReviewErrors = reviews.some((review) => review.error);
  let body = '';
  if (!proofreadingConfig.enabled) {
    body = '<p class="proofreading-empty">Server proofreading is disabled. Browser spellcheck remains available while you write.</p>';
  } else if (proofreading.running) {
    const progress = proofreading.mode === 'chapter' && proofreading.progress.total
      ? ` ${proofreading.progress.completed} of ${proofreading.progress.total} scenes complete.`
      : '';
    body = `<p class="proofreading-empty"><span class="proofreading-spinner" aria-hidden="true"></span> Checking ${proofreading.mode === 'chapter' ? 'chapter scenes.' : 'this scene…'}${progress}</p>`;
  } else if (proofreading.status === 'unavailable') {
    const progress = proofreading.mode === 'chapter' && proofreading.progress.total
      ? ` ${proofreading.progress.completed} of ${proofreading.progress.total} scenes were checked before the review stopped.`
      : '';
    body = `<p class="proofreading-empty">Proofreading is temporarily unavailable.${progress} Your writing and browser spellcheck are unaffected.</p>`;
  } else if (proofreading.status === 'changed') {
    body = '<p class="proofreading-empty">The text changed after this review. Proofread again for current suggestions.</p>';
  } else if (!reviews.length) {
    body = '<p class="proofreading-empty">Run a review when you want spelling and grammar suggestions. Nothing changes until you accept one.</p>';
  } else if (!issueCount && !hasReviewErrors) {
    body = '<p class="proofreading-empty">No spelling or grammar issues were found.</p>';
  } else {
    body = reviews.map((review) => {
      const found = findScene(review.sceneId);
      if (!found) return '';
      if (review.error === 'too-long') return `<section class="proofreading-scene-group">
        ${proofreading.mode === 'chapter' ? `<h4>${escapeHtml(found.scene.title || 'Untitled scene')}</h4>` : ''}
        <p class="proofreading-empty">This scene exceeds the ${proofreadingConfig.maxTextLength.toLocaleString()} character proofreading limit.</p>
      </section>`;
      if (!review.issues.length) return '';
      return `<section class="proofreading-scene-group">
        ${proofreading.mode === 'chapter' ? `<h4>${escapeHtml(found.scene.title || 'Untitled scene')}</h4>` : ''}
        ${review.issues.map((issue) => {
          const dictionaryWord = NovellaProofreading.dictionaryWord(issue);
          const isSelected = proofreading.selected?.sceneId === review.sceneId && proofreading.selected?.issueId === issue.id;
          return `<article class="proofreading-issue ${isSelected ? 'selected' : ''}" data-proofread-locate="${escapeHtml(issue.id)}" data-proofread-scene="${escapeHtml(review.sceneId)}" tabindex="0">
          <div class="proofreading-category">${escapeHtml(issue.category)}</div>
          <p class="proofreading-excerpt">“${escapeHtml(issue.original)}”</p>
          <p class="proofreading-message">${escapeHtml(issue.message)}</p>
          <div class="proofreading-actions">
            ${issue.replacements.map((replacement, index) => `<button data-proofread-accept="${escapeHtml(issue.id)}" data-proofread-scene="${escapeHtml(review.sceneId)}" data-replacement-index="${index}">Accept “${escapeHtml(replacement.value)}”</button>`).join('')}
            ${dictionaryWord ? `<button data-dictionary-add="${escapeHtml(dictionaryWord)}" data-dictionary-scope="novel">Add to novel dictionary</button><button data-dictionary-add="${escapeHtml(dictionaryWord)}" data-dictionary-scope="author">Add to author dictionary</button>` : ''}
            ${!issue.applicable ? '<span class="proofreading-advisory">Advisory only</span>' : ''}
            <button data-proofread-ignore="${escapeHtml(issue.id)}" data-proofread-scene="${escapeHtml(review.sceneId)}">Ignore</button>
            <button data-proofread-ignore-scene="${escapeHtml(issue.id)}" data-proofread-scene="${escapeHtml(review.sceneId)}">Ignore in scene</button>
          </div>
        </article>`;
        }).join('')}
      </section>`;
    }).join('');
  }
  return `<aside class="proofreading-panel" aria-live="polite" aria-label="Proofreading suggestions">
    <div class="proofreading-heading"><strong>Proofreading</strong><div class="proofreading-heading-actions">
      ${issueCount ? `<span>${pluralize(issueCount, 'issue')}</span><button data-proofread-previous ${issueCount ? '' : 'disabled'} aria-label="Previous proofreading issue">←</button><button data-proofread-next ${issueCount ? '' : 'disabled'} aria-label="Next proofreading issue">→</button>` : ''}
      <button data-dictionary-toggle aria-expanded="${dictionaries.open}">${dictionaries.open ? 'Close dictionaries' : 'Dictionaries'}</button>
    </div></div>
    ${body}
    ${dictionaryManagerMarkup()}
  </aside>`;
}

function updateProofreadingPanel() {
  const panel = document.querySelector('.proofreading-panel');
  if (panel) panel.outerHTML = proofreadingPanelMarkup();
  document.querySelectorAll('[data-proofread-scene], [data-proofread-chapter]').forEach((button) => {
    if (button.tagName === 'BUTTON' && !button.dataset.proofreadAccept && !button.dataset.proofreadIgnore && !button.dataset.proofreadIgnoreScene) {
      button.disabled = !proofreadingConfig.enabled || proofreading.running;
    }
  });
}

function editorMarkup(chapter, scene) {
  return `
    <article class="editor">
      <div class="editor-breadcrumb">MANUSCRIPT&nbsp;&nbsp; / &nbsp;&nbsp;<span>${escapeHtml(chapter.title)}</span></div>
      <input class="scene-title-input" data-scene-field="title" aria-label="Scene title" value="${escapeHtml(scene.title)}" placeholder="Untitled scene" />
      <textarea class="scene-synopsis-input" data-scene-field="synopsis" rows="1" aria-label="Scene synopsis" placeholder="Add a brief scene note…">${escapeHtml(scene.synopsis)}</textarea>
      <div class="editor-meta">
        <div class="scene-tools">
          <span id="editorWordCount">${pluralize(countWords(scene.content), 'word')}</span>
          ${narrationButtonMarkup(scene)}
          <button class="proofread-button" data-proofread-scene="${escapeHtml(scene.id)}" ${!proofreadingConfig.enabled || proofreading.running ? 'disabled' : ''}>Proofread scene</button>
          <button class="proofread-button" data-proofread-chapter="${escapeHtml(chapter.id)}" ${!proofreadingConfig.enabled || proofreading.running ? 'disabled' : ''}>Proofread chapter</button>
        </div>
        <button class="delete-link" data-delete-scene="${escapeHtml(scene.id)}">Delete scene</button>
      </div>
      <div class="markdown-toolbar">
        <div class="formatting-tools" role="toolbar" aria-label="Markdown formatting">
          <button class="format-button" data-format="bold" title="Bold (Ctrl/Cmd+B)" aria-label="Bold"><strong>B</strong></button>
          <button class="format-button" data-format="italic" title="Italic (Ctrl/Cmd+I)" aria-label="Italic"><em>I</em></button>
          <span class="toolbar-divider"></span>
          <button class="format-button" data-format="heading" title="Heading" aria-label="Heading">H</button>
          <button class="format-button quote-mark" data-format="quote" title="Blockquote" aria-label="Blockquote">“</button>
          <button class="format-button" data-format="divider" title="Divider" aria-label="Divider">—</button>
          <button class="format-button" data-format="link" title="Link (Ctrl/Cmd+K)" aria-label="Link">↗</button>
        </div>
        <div class="editor-modes" aria-label="Editor mode">
          <button class="mode-button ${editorMode === 'write' ? 'active' : ''}" data-editor-mode="write">Write</button>
          <button class="mode-button ${editorMode === 'preview' ? 'active' : ''}" data-editor-mode="preview">Preview</button>
        </div>
      </div>
      ${proofreadingPanelMarkup()}
      <textarea class="scene-content ${editorMode === 'preview' ? 'hidden' : ''}" data-scene-field="content" spellcheck="true" aria-label="Scene content, Markdown supported" placeholder="Begin writing your scene…">${escapeHtml(scene.content)}</textarea>
      <div class="markdown-preview ${editorMode === 'preview' ? '' : 'hidden'}" aria-label="Formatted scene preview">
        ${scene.content.trim() ? NovellaMarkdown.renderMarkdown(scene.content) : '<p class="preview-empty">Nothing to preview yet.</p>'}
      </div>
    </article>`;
}

function emptyEditorMarkup() {
  return `
    <div class="empty-editor">
      <div class="empty-illustration">§</div>
      <h2>Your next scene starts here</h2>
      <p>Add a chapter and a scene to begin writing. Everything is saved locally as you work.</p>
      <button class="button" data-add-chapter>Create a chapter</button>
    </div>`;
}

function renderLibrary(kind) {
  const isCharacters = kind === 'characters';
  const singular = isCharacters ? 'character' : 'location';
  const items = project[kind];
  const cards = items.map((item) => `
    <article class="reference-card" data-reference-card="${escapeHtml(item.id)}">
      <div class="card-symbol" aria-hidden="true">${isCharacters ? '✦' : '⌂'}</div>
      <button class="icon-button card-delete" data-delete-reference="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.name)}" title="Delete">×</button>
      <input class="reference-name" data-reference-field="name" value="${escapeHtml(item.name)}" aria-label="Name" placeholder="Untitled ${singular}" />
      <input class="reference-role" data-reference-field="role" value="${escapeHtml(item.role)}" aria-label="Role" placeholder="Add a role or type" />
      <textarea class="reference-description" data-reference-field="description" rows="3" aria-label="Description" placeholder="Add notes, details, and history…">${escapeHtml(item.description)}</textarea>
    </article>`).join('');

  app.innerHTML = `
    <section class="library-page">
      <header class="library-header">
        <div>
          <p class="eyebrow">Story reference</p>
          <h1>${isCharacters ? 'Characters' : 'Locations'}</h1>
          <p>${isCharacters ? 'Keep the people in your story vivid and consistent.' : 'Collect the places where your story comes alive.'}</p>
        </div>
        <button class="button" data-add-reference>＋ New ${singular}</button>
      </header>
      <div class="library-grid">
        ${cards || `<div class="empty-library">No ${kind} yet. Add one when your story needs it.</div>`}
      </div>
    </section>`;
  resizeTextareas();
}

function render() {
  if (currentView === 'manuscript') renderManuscript();
  else renderLibrary(currentView);
}

function resizeTextareas(root = document) {
  root.querySelectorAll('textarea:not(.scene-content)').forEach((textarea) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  });
}

function setEditorMode(mode) {
  editorMode = mode;
  const textarea = document.querySelector('.scene-content');
  const preview = document.querySelector('.markdown-preview');
  if (!textarea || !preview) return;

  const isPreview = mode === 'preview';
  textarea.classList.toggle('hidden', isPreview);
  preview.classList.toggle('hidden', !isPreview);
  document.querySelectorAll('[data-editor-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.editorMode === mode);
  });
  document.querySelectorAll('[data-format]').forEach((button) => {
    button.disabled = isPreview;
  });

  if (isPreview) {
    const content = findScene()?.scene.content ?? '';
    preview.innerHTML = content.trim()
      ? NovellaMarkdown.renderMarkdown(content)
      : '<p class="preview-empty">Nothing to preview yet.</p>';
  } else {
    requestAnimationFrame(() => textarea.focus());
  }
}

function updateContentFromEditor(textarea) {
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyMarkdownFormat(format) {
  const textarea = document.querySelector('.scene-content');
  if (!textarea || editorMode !== 'write') return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  const inline = {
    bold: { before: '**', after: '**', placeholder: 'bold text' },
    italic: { before: '*', after: '*', placeholder: 'italic text' },
    link: { before: '[', after: '](https://example.com)', placeholder: 'link text' }
  }[format];

  if (inline) {
    const text = selected || inline.placeholder;
    textarea.setRangeText(`${inline.before}${text}${inline.after}`, start, end, 'end');
    textarea.focus();
    textarea.setSelectionRange(start + inline.before.length, start + inline.before.length + text.length);
    updateContentFromEditor(textarea);
    return;
  }

  if (format === 'divider') {
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const divider = `${before && !before.endsWith('\n\n') ? '\n\n' : ''}---${after && !after.startsWith('\n\n') ? '\n\n' : ''}`;
    textarea.setRangeText(divider, start, end, 'end');
    textarea.focus();
    updateContentFromEditor(textarea);
    return;
  }

  const prefix = format === 'heading' ? '## ' : '> ';
  const lineStart = textarea.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextBreak = textarea.value.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? textarea.value.length : nextBreak;
  const block = textarea.value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const allPrefixed = lines.every((line) => line.startsWith(prefix));
  const replacement = lines.map((line) => allPrefixed ? line.slice(prefix.length) : `${prefix}${line}`).join('\n');
  textarea.setRangeText(replacement, lineStart, lineEnd, 'select');
  textarea.focus();
  updateContentFromEditor(textarea);
}

function addChapter() {
  const number = project.chapters.length + 1;
  const chapter = { id: uid('chapter'), title: `Chapter ${number}`, summary: '', scenes: [] };
  const scene = { id: uid('scene'), title: 'Untitled scene', synopsis: '', content: '' };
  chapter.scenes.push(scene);
  project.chapters.push(chapter);
  activeSceneId = scene.id;
  currentView = 'manuscript';
  render();
  scheduleSave();
  requestAnimationFrame(() => document.querySelector('.scene-title-input')?.select());
}

function addScene(chapterId) {
  const chapter = project.chapters.find((item) => item.id === chapterId);
  if (!chapter) return;
  const scene = { id: uid('scene'), title: 'Untitled scene', synopsis: '', content: '' };
  chapter.scenes.push(scene);
  activeSceneId = scene.id;
  renderManuscript();
  scheduleSave();
  requestAnimationFrame(() => document.querySelector('.scene-title-input')?.select());
}

function addReference() {
  const singular = currentView === 'characters' ? 'character' : 'location';
  project[currentView].push({ id: uid(singular), name: `Untitled ${singular}`, role: '', description: '' });
  renderLibrary(currentView);
  scheduleSave();
  requestAnimationFrame(() => document.querySelector('.reference-card:last-of-type .reference-name')?.select());
}

async function loadNovel(novelId) {
  const response = await fetch(`/api/novels/${encodeURIComponent(novelId)}`);
  if (!response.ok) throw new Error('Unable to load novel');
  project = await response.json();
  activeNovelId = novelId;
  activeSceneId = firstSceneId();
  resetProofreading();
  localStorage.setItem('novella.activeNovelId', novelId);
}

async function switchNovel(novelId) {
  if (!novelId || novelId === activeNovelId) return;
  discardNarration();
  const previousId = activeNovelId;
  if (!(await saveNow())) {
    const switcher = document.querySelector('[data-novel-switcher]');
    if (switcher) switcher.value = previousId;
    return;
  }
  app.innerHTML = '<div class="loading-state"><span class="loader"></span> Opening novel…</div>';
  try {
    await loadNovel(novelId);
    editorMode = 'write';
    render();
    showToast(`Opened “${project.title}”`);
  } catch {
    activeNovelId = previousId;
    render();
    showToast('Could not open that novel.');
  }
}

async function createNovel() {
  discardNarration();
  if (!(await saveNow())) return;
  try {
    const response = await fetch('/api/novels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled novel' })
    });
    if (!response.ok) throw new Error('Unable to create novel');
    const created = await response.json();
    novels.push(created.novel);
    project = created.project;
    activeNovelId = created.novel.id;
    activeSceneId = firstSceneId();
    resetProofreading();
    editorMode = 'write';
    localStorage.setItem('novella.activeNovelId', activeNovelId);
    renderManuscript();
    setSaveStatus('', 'Saved');
    requestAnimationFrame(() => document.querySelector('.project-title-input')?.select());
  } catch {
    showToast('Could not create a new novel.');
  }
}

async function deleteCurrentNovel() {
  if (novels.length <= 1) return;
  const summary = novels.find((novel) => novel.id === activeNovelId);
  if (!summary || !(await askToDelete('Delete this novel?', `“${summary.title}” and all of its chapters, characters, and locations will be permanently removed.`))) return;

  discardNarration();
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await savePromise;
    const response = await fetch(`/api/novels/${encodeURIComponent(activeNovelId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Unable to delete novel');
    const catalog = await response.json();
    novels = catalog.novels;
    await loadNovel(novels[0].id);
    editorMode = 'write';
    render();
    showToast('Novel deleted');
  } catch {
    showToast('Could not delete that novel.');
    render();
  }
}

function askToDelete(title, message) {
  document.querySelector('#confirmTitle').textContent = title;
  document.querySelector('#confirmMessage').textContent = message;
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), { once: true });
  });
}

async function deleteScene(sceneId) {
  const found = findScene(sceneId);
  if (!found || !(await askToDelete('Delete this scene?', `“${found.scene.title || 'Untitled scene'}” will be permanently removed.`))) return;
  if (narration.sceneId === sceneId) discardNarration();
  found.chapter.scenes = found.chapter.scenes.filter((scene) => scene.id !== sceneId);
  activeSceneId = firstSceneId();
  renderManuscript();
  scheduleSave();
}

async function deleteChapter(chapterId) {
  const chapter = project.chapters.find((item) => item.id === chapterId);
  if (!chapter || !(await askToDelete('Delete this chapter?', `“${chapter.title}” and its ${pluralize(chapter.scenes.length, 'scene')} will be permanently removed.`))) return;
  project.chapters = project.chapters.filter((item) => item.id !== chapterId);
  if (!findScene()) activeSceneId = firstSceneId();
  renderManuscript();
  scheduleSave();
}

async function deleteReference(id) {
  const item = project[currentView].find((entry) => entry.id === id);
  if (!item || !(await askToDelete(`Delete this ${currentView === 'characters' ? 'character' : 'location'}?`, `“${item.name}” will be permanently removed.`))) return;
  project[currentView] = project[currentView].filter((entry) => entry.id !== id);
  renderLibrary(currentView);
  scheduleSave();
}

async function requestProofreading(scene, serial) {
  const snapshot = scene.content;
  const novelId = activeNovelId;
  if (snapshot.length > proofreadingConfig.maxTextLength) {
    proofreading.reviews.set(scene.id, { novelId, sceneId: scene.id, snapshot, issues: [], error: 'too-long' });
    proofreading.status = 'available';
    return true;
  }
  try {
    const response = await fetch('/api/proofreading/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ novelId, sceneId: scene.id, text: snapshot, language: proofreadingConfig.language })
    });
    if (!response.ok) throw new Error('Proofreading request failed.');
    const result = await response.json();
    if (!NovellaProofreading.responseMatches(serial, proofreading.requestSerial, novelId, activeNovelId)) return false;
    const current = findScene(scene.id)?.scene;
    if (!current || current.content !== snapshot) return false;
    if (result.status !== 'available') {
      proofreading.status = result.status === 'disabled' ? 'disabled' : 'unavailable';
      return false;
    }
    proofreading.reviews.set(scene.id, {
      novelId,
      sceneId: scene.id,
      snapshot,
      issues: Array.isArray(result.issues) ? result.issues : []
    });
    proofreading.status = 'available';
    return true;
  } catch {
    if (serial === proofreading.requestSerial) proofreading.status = 'unavailable';
    return false;
  }
}

async function proofreadScene(sceneId = activeSceneId) {
  const found = findScene(sceneId);
  if (!found || !proofreadingConfig.enabled || proofreading.running) return;
  const serial = ++proofreading.requestSerial;
  proofreading.running = true;
  proofreading.mode = 'scene';
  proofreading.novelId = activeNovelId;
  proofreading.chapterId = found.chapter.id;
  proofreading.status = 'checking';
  proofreading.reviews.clear();
  proofreading.selected = null;
  proofreading.progress = { completed: 0, total: 1 };
  updateProofreadingPanel();
  await requestProofreading(found.scene, serial);
  if (serial !== proofreading.requestSerial) return;
  proofreading.progress.completed = 1;
  proofreading.running = false;
  updateProofreadingPanel();
}

async function proofreadChapter(chapterId) {
  const chapter = project.chapters.find((item) => item.id === chapterId);
  if (!chapter || !proofreadingConfig.enabled || proofreading.running) return;
  const serial = ++proofreading.requestSerial;
  proofreading.running = true;
  proofreading.mode = 'chapter';
  proofreading.novelId = activeNovelId;
  proofreading.chapterId = chapter.id;
  proofreading.status = 'checking';
  proofreading.reviews.clear();
  proofreading.selected = null;
  proofreading.progress = { completed: 0, total: chapter.scenes.length };
  updateProofreadingPanel();
  await NovellaProofreading.runSequential(
    chapter.scenes,
    async (scene) => serial === proofreading.requestSerial ? requestProofreading(scene, serial) : false,
    (completed) => serial !== proofreading.requestSerial || (!completed && proofreading.status === 'unavailable'),
    (completed) => {
      if (serial !== proofreading.requestSerial) return;
      proofreading.progress.completed = completed;
      updateProofreadingPanel();
    }
  );
  if (serial !== proofreading.requestSerial) return;
  proofreading.running = false;
  updateProofreadingPanel();
}

function locateProofreadingIssue(sceneId, issueId) {
  const review = proofreading.reviews.get(sceneId);
  const issue = review?.issues.find((item) => item.id === issueId);
  const found = findScene(sceneId);
  if (!issue || !found) return;
  proofreading.selected = { sceneId, issueId };
  if (activeSceneId !== sceneId) {
    activeSceneId = sceneId;
    editorMode = 'write';
    renderManuscript();
  } else if (editorMode !== 'write') {
    setEditorMode('write');
    updateProofreadingPanel();
  } else {
    updateProofreadingPanel();
  }
  requestAnimationFrame(() => {
    const textarea = document.querySelector('.scene-content');
    if (!textarea || !NovellaProofreading.reviewMatches(review, activeNovelId, sceneId, textarea.value)) return;
    textarea.focus();
    textarea.setSelectionRange(issue.start, issue.end);
  });
}

function ignoreProofreadingIssue(sceneId, issueId, throughoutScene = false) {
  const review = proofreading.reviews.get(sceneId);
  const issue = review?.issues.find((item) => item.id === issueId);
  if (!review || !issue) return;
  review.issues = throughoutScene
    ? review.issues.filter((item) => !(item.original === issue.original && (item.ruleId || item.message) === (issue.ruleId || issue.message)))
    : review.issues.filter((item) => item.id !== issueId);
  if (proofreading.selected?.issueId === issueId && proofreading.selected?.sceneId === sceneId) proofreading.selected = null;
  updateProofreadingPanel();
}

function navigateProofreadingIssue(direction) {
  const reviews = proofreading.mode === 'chapter' && proofreading.chapterId
    ? (project.chapters.find((chapter) => chapter.id === proofreading.chapterId)?.scenes || [])
      .map((scene) => proofreading.reviews.get(scene.id)).filter(Boolean)
    : [proofreading.reviews.get(activeSceneId)].filter(Boolean);
  const next = NovellaProofreading.adjacentIssue(reviews, proofreading.selected, direction);
  if (next) locateProofreadingIssue(next.sceneId, next.issueId);
}

async function loadDictionaries() {
  if (!activeNovelId) return;
  const novelId = activeNovelId;
  dictionaries.loading = true;
  dictionaries.error = '';
  updateProofreadingPanel();
  try {
    const response = await fetch(`/api/proofreading/dictionaries?novelId=${encodeURIComponent(novelId)}`);
    if (!response.ok) throw new Error('Dictionaries could not be loaded.');
    const result = await response.json();
    if (dictionaries.novelId !== novelId || activeNovelId !== novelId) return;
    dictionaries.author = Array.isArray(result.author) ? result.author : [];
    dictionaries.novel = Array.isArray(result.novel) ? result.novel : [];
    dictionaries.loaded = true;
  } catch (error) {
    if (dictionaries.novelId === novelId) dictionaries.error = error.message;
  } finally {
    if (dictionaries.novelId === novelId) {
      dictionaries.loading = false;
      updateProofreadingPanel();
    }
  }
}

function toggleDictionaries() {
  dictionaries.open = !dictionaries.open;
  updateProofreadingPanel();
  if (dictionaries.open && !dictionaries.loaded) loadDictionaries();
}

async function mutateDictionary(method, scope, entry) {
  const novelId = activeNovelId;
  try {
    const response = await fetch('/api/proofreading/dictionaries', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ novelId, scope, entry })
    });
    const result = await response.json().catch(() => ({ error: 'Dictionary update failed.' }));
    if (!response.ok) throw new Error(result.error || 'Dictionary update failed.');
    if (activeNovelId !== novelId || dictionaries.novelId !== novelId) return false;
    const values = result.dictionaries || result;
    dictionaries.author = Array.isArray(values.author) ? values.author : [];
    dictionaries.novel = Array.isArray(values.novel) ? values.novel : [];
    dictionaries.loaded = true;
    dictionaries.error = '';
    updateProofreadingPanel();
    return true;
  } catch (error) {
    dictionaries.error = error.message;
    dictionaries.open = true;
    updateProofreadingPanel();
    return false;
  }
}

async function refreshProofreadingAfterDictionaryChange() {
  if (!proofreadingConfig.enabled) return;
  if (proofreading.mode === 'chapter' && proofreading.chapterId) await proofreadChapter(proofreading.chapterId);
  else await proofreadScene(activeSceneId);
}

async function addDictionaryEntry(scope, entry) {
  if (!(await mutateDictionary('POST', scope, entry))) return;
  showToast(`Added “${entry}” to the ${scope} dictionary`);
  await refreshProofreadingAfterDictionaryChange();
}

async function removeDictionaryEntry(scope, entry) {
  const novelId = activeNovelId;
  if (!(await askToDelete('Remove dictionary word?', `“${entry}” will be checked again in future reviews.`))) return;
  if (activeNovelId !== novelId) return showToast('The active novel changed; no dictionary entry was removed.');
  if (!(await mutateDictionary('DELETE', scope, entry))) return;
  showToast(`Removed “${entry}” from the ${scope} dictionary`);
  await refreshProofreadingAfterDictionaryChange();
}

function acceptProofreadingIssue(sceneId, issueId, replacementIndex) {
  const review = proofreading.reviews.get(sceneId);
  const issue = review?.issues.find((item) => item.id === issueId);
  const replacement = issue?.replacements?.[replacementIndex]?.value;
  if (!review || !issue || activeNovelId !== review.novelId) return showToast('This suggestion is no longer current.');
  if (activeSceneId !== sceneId) {
    locateProofreadingIssue(sceneId, issueId);
    return showToast('Review the suggestion in its scene before accepting it.');
  }
  const textarea = document.querySelector('.scene-content');
  if (!NovellaProofreading.applyReplacement(textarea, review, issue, replacement, activeNovelId, activeSceneId)) {
    proofreading.status = 'changed';
    proofreading.reviews.delete(sceneId);
    updateProofreadingPanel();
    return showToast('The text changed. Proofread again before accepting.');
  }
  showToast('Suggestion applied');
  proofreadScene(sceneId);
}

document.querySelector('.primary-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  discardNarration();
  currentView = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item === button));
  render();
});

app.addEventListener('click', (event) => {
  if (event.target.closest('[data-dictionary-toggle]')) return toggleDictionaries();
  if (event.target.closest('[data-proofread-previous]')) return navigateProofreadingIssue(-1);
  if (event.target.closest('[data-proofread-next]')) return navigateProofreadingIssue(1);
  const dictionaryAddButton = event.target.closest('[data-dictionary-add]');
  if (dictionaryAddButton) return addDictionaryEntry(dictionaryAddButton.dataset.dictionaryScope, dictionaryAddButton.dataset.dictionaryAdd);
  const dictionaryRemoveButton = event.target.closest('[data-dictionary-remove]');
  if (dictionaryRemoveButton) return removeDictionaryEntry(dictionaryRemoveButton.dataset.dictionaryScope, dictionaryRemoveButton.dataset.dictionaryRemove);
  const acceptButton = event.target.closest('[data-proofread-accept]');
  if (acceptButton) return acceptProofreadingIssue(acceptButton.dataset.proofreadScene, acceptButton.dataset.proofreadAccept, Number(acceptButton.dataset.replacementIndex));
  const ignoreSceneButton = event.target.closest('[data-proofread-ignore-scene]');
  if (ignoreSceneButton) return ignoreProofreadingIssue(ignoreSceneButton.dataset.proofreadScene, ignoreSceneButton.dataset.proofreadIgnoreScene, true);
  const ignoreButton = event.target.closest('[data-proofread-ignore]');
  if (ignoreButton) return ignoreProofreadingIssue(ignoreButton.dataset.proofreadScene, ignoreButton.dataset.proofreadIgnore);
  const issueCard = event.target.closest('[data-proofread-locate]');
  if (issueCard) return locateProofreadingIssue(issueCard.dataset.proofreadScene, issueCard.dataset.proofreadLocate);
  const proofreadSceneButton = event.target.closest('button[data-proofread-scene]');
  if (proofreadSceneButton) return proofreadScene(proofreadSceneButton.dataset.proofreadScene);
  const proofreadChapterButton = event.target.closest('[data-proofread-chapter]');
  if (proofreadChapterButton) return proofreadChapter(proofreadChapterButton.dataset.proofreadChapter);
  const listenButton = event.target.closest('[data-listen-scene]');
  if (listenButton) return toggleNarration(listenButton.dataset.listenScene);
  const formatButton = event.target.closest('[data-format]');
  if (formatButton) return applyMarkdownFormat(formatButton.dataset.format);
  const modeButton = event.target.closest('[data-editor-mode]');
  if (modeButton) return setEditorMode(modeButton.dataset.editorMode);
  if (event.target.closest('[data-add-novel]')) return createNovel();
  if (event.target.closest('[data-delete-novel]')) return deleteCurrentNovel();
  const sceneRow = event.target.closest('.scene-row');
  if (sceneRow && !draggedItem) {
    if (sceneRow.dataset.sceneId !== activeSceneId) discardNarration();
    activeSceneId = sceneRow.dataset.sceneId;
    renderManuscript();
    return;
  }
  const addSceneButton = event.target.closest('[data-add-scene]');
  if (addSceneButton) return addScene(addSceneButton.dataset.addScene);
  if (event.target.closest('[data-add-chapter]')) return addChapter();
  if (event.target.closest('[data-add-reference]')) return addReference();
  const deleteSceneButton = event.target.closest('[data-delete-scene]');
  if (deleteSceneButton) return deleteScene(deleteSceneButton.dataset.deleteScene);
  const deleteChapterButton = event.target.closest('[data-delete-chapter]');
  if (deleteChapterButton) return deleteChapter(deleteChapterButton.dataset.deleteChapter);
  const deleteReferenceButton = event.target.closest('[data-delete-reference]');
  if (deleteReferenceButton) return deleteReference(deleteReferenceButton.dataset.deleteReference);
});

app.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-dictionary-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  addDictionaryEntry(String(data.get('scope') || ''), String(data.get('entry') || ''));
});

app.addEventListener('change', (event) => {
  if (event.target.matches('[data-novel-switcher]')) switchNovel(event.target.value);
});

app.addEventListener('input', (event) => {
  const input = event.target;
  if (input.dataset.projectField) {
    project[input.dataset.projectField] = input.value;
    const summary = novels.find((novel) => novel.id === activeNovelId);
    if (summary) summary[input.dataset.projectField] = input.value;
    if (input.dataset.projectField === 'title') {
      const option = document.querySelector(`[data-novel-switcher] option[value="${CSS.escape(activeNovelId)}"]`);
      if (option) option.textContent = input.value || 'Untitled novel';
    }
  }

  if (input.dataset.chapterTitle) {
    const chapter = project.chapters.find((item) => item.id === input.dataset.chapterTitle);
    if (chapter) chapter.title = input.value;
  }

  if (input.dataset.sceneField) {
    const found = findScene();
    if (!found) return;
    found.scene[input.dataset.sceneField] = input.value;
    if (input.dataset.sceneField === 'title') {
      const label = document.querySelector(`[data-scene-id="${CSS.escape(found.scene.id)}"] .scene-name`);
      if (label) label.textContent = input.value || 'Untitled scene';
    }
    if (input.dataset.sceneField === 'content') {
      const existingReview = proofreading.reviews.get(found.scene.id);
      if (existingReview && existingReview.snapshot !== input.value) {
        proofreading.requestSerial += 1;
        proofreading.running = false;
        proofreading.status = 'changed';
        proofreading.reviews.delete(found.scene.id);
        updateProofreadingPanel();
      }
      if (narration.sceneId === found.scene.id) discardNarration();
      const count = countWords(input.value);
      const editorCount = document.querySelector('#editorWordCount');
      const outlineCount = document.querySelector(`[data-scene-id="${CSS.escape(found.scene.id)}"] .scene-word-count`);
      if (editorCount) editorCount.textContent = pluralize(count, 'word');
      if (outlineCount) outlineCount.textContent = count;
    }
  }

  if (input.dataset.referenceField) {
    const card = input.closest('[data-reference-card]');
    const reference = project[currentView].find((item) => item.id === card?.dataset.referenceCard);
    if (reference) reference[input.dataset.referenceField] = input.value;
  }
  scheduleSave();
});

app.addEventListener('keydown', (event) => {
  const proofreadIssue = event.target.closest?.('[data-proofread-locate]');
  if (proofreadIssue && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    locateProofreadingIssue(proofreadIssue.dataset.proofreadScene, proofreadIssue.dataset.proofreadLocate);
    return;
  }
  if (event.target.matches('.scene-content') && (event.metaKey || event.ctrlKey)) {
    const shortcut = { b: 'bold', i: 'italic', k: 'link' }[event.key.toLowerCase()];
    if (shortcut) {
      event.preventDefault();
      applyMarkdownFormat(shortcut);
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveNow();
  }
  if (event.target.matches('.scene-row') && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    activeSceneId = event.target.dataset.sceneId;
    renderManuscript();
  }
});

app.addEventListener('dragstart', (event) => {
  const scene = event.target.closest('.scene-row');
  if (scene) {
    draggedItem = { type: 'scene', id: scene.dataset.sceneId };
    scene.classList.add('dragging');
    event.stopPropagation();
  } else {
    const chapter = event.target.closest('.chapter-group');
    if (!chapter) return;
    draggedItem = { type: 'chapter', id: chapter.dataset.chapterId };
    chapter.classList.add('dragging');
  }
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedItem.id);
});

app.addEventListener('dragover', (event) => {
  if (!draggedItem) return;
  const target = draggedItem.type === 'scene'
    ? event.target.closest('.scene-row, .scene-list')
    : event.target.closest('.chapter-group');
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drop-before').forEach((item) => item.classList.remove('drop-before'));
  target.classList.add('drop-before');
});

app.addEventListener('drop', (event) => {
  if (!draggedItem) return;
  event.preventDefault();
  if (draggedItem.type === 'chapter') {
    const target = event.target.closest('.chapter-group');
    if (!target || target.dataset.chapterId === draggedItem.id) return;
    const from = project.chapters.findIndex((chapter) => chapter.id === draggedItem.id);
    const [chapter] = project.chapters.splice(from, 1);
    const to = project.chapters.findIndex((item) => item.id === target.dataset.chapterId);
    project.chapters.splice(to, 0, chapter);
  } else {
    const targetSceneRow = event.target.closest('.scene-row');
    const targetList = event.target.closest('.scene-list');
    if (targetSceneRow?.dataset.sceneId === draggedItem.id) {
      draggedItem = null;
      renderManuscript();
      return;
    }
    const source = findScene(draggedItem.id);
    if (!source || !targetList) return;
    source.chapter.scenes = source.chapter.scenes.filter((scene) => scene.id !== draggedItem.id);
    const targetChapter = project.chapters.find((chapter) => chapter.id === targetList.dataset.sceneList);
    if (!targetChapter) return;
    const targetIndex = targetSceneRow ? targetChapter.scenes.findIndex((scene) => scene.id === targetSceneRow.dataset.sceneId) : targetChapter.scenes.length;
    targetChapter.scenes.splice(targetIndex < 0 ? targetChapter.scenes.length : targetIndex, 0, source.scene);
  }
  draggedItem = null;
  renderManuscript();
  scheduleSave();
});

app.addEventListener('dragend', () => {
  draggedItem = null;
  document.querySelectorAll('.dragging, .drop-before').forEach((item) => item.classList.remove('dragging', 'drop-before'));
});

function startDownload(url) {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

document.querySelector('[data-export-manuscript]').addEventListener('click', async () => {
  if (!(await saveNow())) return;
  startDownload(`/api/novels/${encodeURIComponent(activeNovelId)}/export?t=${Date.now()}`);
  showToast('Markdown export created');
});

document.querySelector('[data-export-project]').addEventListener('click', async () => {
  if (!(await saveNow())) return;
  startDownload(`/api/novels/${encodeURIComponent(activeNovelId)}/project-export?t=${Date.now()}`);
  showToast('Project export created');
});

document.querySelector('[data-import-project]').addEventListener('click', () => {
  projectImportFile.value = '';
  projectImportFile.click();
});

function confirmProjectImport(preview) {
  const byline = preview.author ? ` by ${preview.author}` : '';
  const dictionaryCount = `${preview.dictionaryEntries.toLocaleString()} novel dictionary ${preview.dictionaryEntries === 1 ? 'entry' : 'entries'}`;
  importSummary.textContent = `“${preview.title || 'Untitled novel'}”${byline} contains ${pluralize(preview.chapters, 'chapter')}, ${pluralize(preview.scenes, 'scene')}, ${pluralize(preview.characters, 'character')}, ${pluralize(preview.locations, 'location')}, and ${dictionaryCount}. Your existing novels will not be changed.`;
  importDialog.showModal();
  return new Promise((resolve) => {
    importDialog.addEventListener('close', () => resolve(importDialog.returnValue === 'confirm'), { once: true });
  });
}

projectImportFile.addEventListener('change', async () => {
  const file = projectImportFile.files?.[0];
  if (!file) return;
  if (file.size > PROJECT_IMPORT_MAX_BYTES) return showToast('Project files are limited to 20 MiB.');
  if (!(await saveNow())) return;

  try {
    const source = await file.text();
    const previewResponse = await fetch('/api/projects/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: source
    });
    const previewResult = await previewResponse.json().catch(() => ({ error: 'The project file could not be read.' }));
    if (!previewResponse.ok) throw new Error(previewResult.error || 'The project file is invalid.');
    if (!(await confirmProjectImport(previewResult.preview))) return;

    const importResponse = await fetch('/api/projects/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: source
    });
    const imported = await importResponse.json().catch(() => ({ error: 'The project could not be imported.' }));
    if (!importResponse.ok) throw new Error(imported.error || 'The project could not be imported.');

    discardNarration();
    const catalogResponse = await fetch('/api/novels');
    if (!catalogResponse.ok) throw new Error('The imported novel could not be opened.');
    novels = (await catalogResponse.json()).novels;
    project = imported.project;
    activeNovelId = imported.novel.id;
    activeSceneId = firstSceneId();
    resetProofreading();
    editorMode = 'write';
    localStorage.setItem('novella.activeNovelId', activeNovelId);
    currentView = 'manuscript';
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === currentView));
    render();
    setSaveStatus('', 'Saved');
    showToast('Project imported as a new novel');
  } catch (error) {
    showToast(error.message || 'The project could not be imported.');
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!saveTimer) return;
  event.preventDefault();
});

async function init() {
  try {
    const [catalogResponse, ttsResponse, proofreadingResponse, sessionResponse] = await Promise.all([
      fetch('/api/novels'),
      fetch('/api/tts/config').catch(() => null),
      fetch('/api/proofreading/config').catch(() => null),
      fetch('/api/auth/session').catch(() => null)
    ]);
    if (!catalogResponse.ok) throw new Error('Unable to load novel catalog');
    if (ttsResponse?.ok) ttsConfig = await ttsResponse.json();
    if (proofreadingResponse?.ok) proofreadingConfig = await proofreadingResponse.json();
    if (sessionResponse?.ok) {
      const session = await sessionResponse.json();
      if (session.required && session.user) {
        authUser.textContent = session.user.name || session.user.username || 'Signed in';
        csrfToken.value = session.csrfToken;
        authInfo.hidden = false;
      }
    }
    const catalog = await catalogResponse.json();
    novels = catalog.novels;
    const remembered = localStorage.getItem('novella.activeNovelId');
    const initialNovel = novels.find((novel) => novel.id === remembered) || novels[0];
    if (!initialNovel) throw new Error('Novel catalog is empty');
    await loadNovel(initialNovel.id);
    render();
  } catch (error) {
    app.innerHTML = `<div class="empty-editor"><div class="empty-illustration">!</div><h2>We couldn't open your manuscript</h2><p>Make sure the local Novella server is running, then refresh this page.</p></div>`;
    setSaveStatus('error', 'Offline');
  }
}

init();
