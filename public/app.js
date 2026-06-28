const app = document.querySelector('#app');
const saveStatus = document.querySelector('#saveStatus');
const toast = document.querySelector('#toast');
const confirmDialog = document.querySelector('#confirmDialog');

let project = null;
let currentView = 'manuscript';
let activeSceneId = null;
let saveTimer = null;
let savePromise = Promise.resolve();
let draggedItem = null;
let editorMode = 'write';
let novels = [];
let activeNovelId = null;

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

function editorMarkup(chapter, scene) {
  return `
    <article class="editor">
      <div class="editor-breadcrumb">MANUSCRIPT&nbsp;&nbsp; / &nbsp;&nbsp;<span>${escapeHtml(chapter.title)}</span></div>
      <input class="scene-title-input" data-scene-field="title" aria-label="Scene title" value="${escapeHtml(scene.title)}" placeholder="Untitled scene" />
      <textarea class="scene-synopsis-input" data-scene-field="synopsis" rows="1" aria-label="Scene synopsis" placeholder="Add a brief scene note…">${escapeHtml(scene.synopsis)}</textarea>
      <div class="editor-meta">
        <span id="editorWordCount">${pluralize(countWords(scene.content), 'word')}</span>
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
      <textarea class="scene-content ${editorMode === 'preview' ? 'hidden' : ''}" data-scene-field="content" aria-label="Scene content, Markdown supported" placeholder="Begin writing your scene…">${escapeHtml(scene.content)}</textarea>
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
  localStorage.setItem('novella.activeNovelId', novelId);
}

async function switchNovel(novelId) {
  if (!novelId || novelId === activeNovelId) return;
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

document.querySelector('.primary-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  currentView = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item === button));
  render();
});

app.addEventListener('click', (event) => {
  const formatButton = event.target.closest('[data-format]');
  if (formatButton) return applyMarkdownFormat(formatButton.dataset.format);
  const modeButton = event.target.closest('[data-editor-mode]');
  if (modeButton) return setEditorMode(modeButton.dataset.editorMode);
  if (event.target.closest('[data-add-novel]')) return createNovel();
  if (event.target.closest('[data-delete-novel]')) return deleteCurrentNovel();
  const sceneRow = event.target.closest('.scene-row');
  if (sceneRow && !draggedItem) {
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

document.querySelector('.export-button').addEventListener('click', async (event) => {
  event.preventDefault();
  if (!(await saveNow())) return;
  const link = document.createElement('a');
  link.href = `/api/novels/${encodeURIComponent(activeNovelId)}/export?t=${Date.now()}`;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast('Markdown export created');
});

window.addEventListener('beforeunload', (event) => {
  if (!saveTimer) return;
  event.preventDefault();
});

async function init() {
  try {
    const catalogResponse = await fetch('/api/novels');
    if (!catalogResponse.ok) throw new Error('Unable to load novel catalog');
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
