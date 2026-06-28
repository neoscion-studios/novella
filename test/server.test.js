const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp, projectToMarkdown, validateProject } = require('../server');
const { renderMarkdown } = require('../public/markdown');

const sample = {
  title: 'A Small Story',
  author: 'Ada Author',
  chapters: [{
    id: 'c1',
    title: 'The Beginning',
    summary: '',
    scenes: [{ id: 's1', title: 'Arrival', synopsis: '', content: 'Once upon a test.' }]
  }],
  characters: [],
  locations: []
};

test('validates and normalizes project data', () => {
  const project = validateProject({ title: 'Test', chapters: [{ scenes: [{}] }] });
  assert.equal(project.version, 1);
  assert.equal(project.chapters[0].title, 'Chapter 1');
  assert.equal(project.chapters[0].scenes[0].title, 'Scene 1');
  assert.deepEqual(project.characters, []);
});

test('exports manuscript content in chapter and scene order', () => {
  assert.equal(
    projectToMarkdown(sample),
    '# A Small Story\n\n*By Ada Author*\n\n## The Beginning\n\nOnce upon a test.\n'
  );
});

test('omits scene names, separates scenes, and reserves structural heading levels', () => {
  const formatted = structuredClone(sample);
  formatted.chapters[0].scenes = [
    {
      id: 's1',
      title: 'Internal scene name',
      synopsis: '',
      content: '# Inside the room\n\n## A detail\n\n```md\n# Preserved in code\n```'
    },
    { id: 's2', title: 'Another internal name', synopsis: '', content: 'The next scene.' },
    { id: 's3', title: 'Empty scene', synopsis: '', content: '' }
  ];

  const exported = projectToMarkdown(formatted);
  assert.doesNotMatch(exported, /Internal scene name|Another internal name|Empty scene/);
  assert.match(exported, /### Inside the room/);
  assert.match(exported, /#### A detail/);
  assert.match(exported, /```md\n# Preserved in code\n```/);
  assert.match(exported, /```\n\n\* \* \*\n\nThe next scene\./);
});

test('renders safe Markdown previews', () => {
  const rendered = renderMarkdown('## A **turn**\n\n> Be careful.\n\n[Home](/notes)\n\n<script>alert(1)</script>');
  assert.match(rendered, /<h2>A <strong>turn<\/strong><\/h2>/);
  assert.match(rendered, /<blockquote>Be careful\.<\/blockquote>/);
  assert.match(rendered, /<a href="\/notes">Home<\/a>/);
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /&lt;script&gt;/);
});

test('serves and saves a project through the API', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-test-'));
  const dataFile = path.join(directory, 'project.json');
  await fs.writeFile(dataFile, JSON.stringify(sample));
  const server = http.createServer(createApp({ dataFile }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${base}/api/project`).then((response) => response.json());
  assert.equal(initial.title, 'A Small Story');

  initial.title = 'A Changed Story';
  const saved = await fetch(`${base}/api/project`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initial)
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(await fs.readFile(dataFile, 'utf8')).title, 'A Changed Story');

  const exported = await fetch(`${base}/api/export`);
  assert.match(exported.headers.get('content-disposition'), /a-changed-story\.md/);
  assert.match(await exported.text(), /^# A Changed Story/);
});
