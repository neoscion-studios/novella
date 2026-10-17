const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SqliteStore } = require('../storage');
const {
  MAX_PROJECT_IMPORT_SIZE,
  projectImportSummary,
  validateProjectEnvelope
} = require('../project-format');

const fixturePath = path.join(__dirname, 'fixtures', 'novella-project-v1.json');
const identity = { tenantId: 'local-test', objectId: 'portable-owner', name: 'Owner', username: 'owner@example.com' };

async function fixture() {
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}

test('validates the documented portable v1 fixture without losing supported data', async () => {
  const source = await fixture();
  const validated = validateProjectEnvelope(source);
  assert.deepEqual(validated, source);
  assert.deepEqual(projectImportSummary(validated), {
    title: 'The Élan Archive',
    author: 'Example Author',
    chapters: 1,
    scenes: 1,
    characters: 1,
    locations: 1,
    dictionaryEntries: 1
  });
});

test('rejects malformed files, unsupported versions, unknown fields, and duplicate IDs', async () => {
  const source = await fixture();
  assert.throws(() => validateProjectEnvelope(null), /must be an object/);
  assert.throws(() => validateProjectEnvelope({ ...source, version: 2 }), /supports version 1/);
  assert.throws(() => validateProjectEnvelope({ ...source, secret: 'unexpected' }), /unsupported field/);
  assert.throws(() => validateProjectEnvelope({ ...source, exportedAt: '1' }), /ISO-8601 timestamp/);

  const duplicate = structuredClone(source);
  duplicate.novel.project.characters[0].id = duplicate.novel.project.chapters[0].scenes[0].id;
  assert.throws(() => validateProjectEnvelope(duplicate), /Duplicate project ID/);
});

test('imports as new records despite source ID collisions and preserves project data', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-portable-store-'));
  const store = new SqliteStore(path.join(directory, 'novella.sqlite'));
  t.after(() => store.close());
  const source = validateProjectEnvelope(await fixture());

  const first = store.importProject(identity, source);
  const second = store.importProject(identity, source);
  assert.notEqual(first.novel.id, source.novel.id);
  assert.notEqual(second.novel.id, source.novel.id);
  assert.notEqual(first.novel.id, second.novel.id);
  assert.deepEqual(store.read(identity, first.novel.id), source.novel.project);
  assert.deepEqual(store.dictionaries(identity, first.novel.id).novel.map(({ entry }) => entry), ['Caelion']);
});

test('rolls back the entire import when a dictionary insert is interrupted', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-portable-rollback-'));
  const store = new SqliteStore(path.join(directory, 'novella.sqlite'));
  t.after(() => store.close());
  const source = validateProjectEnvelope(await fixture());
  store.database.exec(`
    CREATE TRIGGER interrupt_portable_import
    BEFORE INSERT ON novel_dictionary_entries
    BEGIN
      SELECT RAISE(ABORT, 'simulated interruption');
    END;
  `);

  assert.throws(() => store.importProject(identity, source), /simulated interruption/);
  assert.equal(store.catalog(identity).novels.length, 0);
});

test('defines a dedicated full-project request limit above the normal API limit', () => {
  assert.equal(MAX_PROJECT_IMPORT_SIZE, 20 * 1024 * 1024);
  assert.ok(MAX_PROJECT_IMPORT_SIZE > 5 * 1024 * 1024);
});

test('portable UI labels all operations and flushes autosave before exports and import preview', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = await fs.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, />\s*Export Manuscript \(\.md\)\s*</);
  assert.match(html, />Export Project \(\.json\)</);
  assert.match(html, />Import Project \(\.json\)</);

  const manuscriptHandler = app.slice(app.indexOf("'[data-export-manuscript]'"), app.indexOf("'[data-export-project]'"));
  const projectHandler = app.slice(app.indexOf("'[data-export-project]'"), app.indexOf("'[data-import-project]'"));
  const importHandler = app.slice(app.indexOf("projectImportFile.addEventListener('change'"));
  assert.ok(manuscriptHandler.indexOf('await saveNow()') < manuscriptHandler.indexOf('startDownload('));
  assert.ok(projectHandler.indexOf('await saveNow()') < projectHandler.indexOf('startDownload('));
  assert.ok(importHandler.indexOf('await saveNow()') < importHandler.indexOf("fetch('/api/projects/import/preview'"));
});
