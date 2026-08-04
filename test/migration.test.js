const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadLegacyRecords } = require('../legacy-import');
const { SqliteStore } = require('../storage');
const { requireGuid } = require('../scripts/migrate-json-to-sqlite');

const project = {
  title: 'Imported Story',
  author: 'Existing Author',
  chapters: [{ id: 'c1', title: 'Chapter One', summary: '', scenes: [] }],
  characters: [],
  locations: []
};

test('imports legacy JSON idempotently into one stable Entra identity', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-import-'));
  await fs.mkdir(path.join(directory, 'novels'));
  await fs.writeFile(path.join(directory, 'catalog.json'), JSON.stringify({
    version: 1,
    novels: [{
      id: 'existing-novel',
      title: project.title,
      author: project.author,
      createdAt: '2025-01-02T03:04:05.000Z',
      updatedAt: '2025-02-03T04:05:06.000Z'
    }]
  }));
  const legacyNovelFile = path.join(directory, 'novels', 'existing-novel.json');
  await fs.writeFile(legacyNovelFile, JSON.stringify(project));
  const originalJson = await fs.readFile(legacyNovelFile, 'utf8');

  const records = await loadLegacyRecords({ dataDir: directory });
  assert.equal(records.length, 1);
  assert.equal(records[0].project.title, 'Imported Story');

  const store = new SqliteStore(path.join(directory, 'novella.sqlite'));
  t.after(() => store.close());
  const owner = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    objectId: '22222222-2222-2222-2222-222222222222',
    name: 'Example Owner',
    username: 'owner@example.com'
  };
  assert.deepEqual(store.import(owner, records), { imported: 1, skipped: 0 });
  assert.deepEqual(store.import(owner, records), { imported: 0, skipped: 1 });
  assert.equal(store.read(owner, 'existing-novel').title, 'Imported Story');
  assert.equal(store.catalog(owner).novels[0].createdAt, '2025-01-02T03:04:05.000Z');

  const anotherUser = { tenantId: owner.tenantId, objectId: '33333333-3333-3333-3333-333333333333' };
  assert.deepEqual(store.catalog(anotherUser).novels, []);
  assert.equal(await fs.readFile(legacyNovelFile, 'utf8'), originalJson);

  const conflicting = structuredClone(records);
  conflicting[0].project.title = 'Different content';
  assert.throws(() => store.import(owner, conflicting), /already exists with different content/);
  assert.equal(store.read(owner, 'existing-novel').title, 'Imported Story');
});

test('requires stable Entra GUIDs for migration ownership', () => {
  assert.equal(
    requireGuid('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', '--object-id'),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );
  assert.throws(() => requireGuid('owner@example.com', '--object-id'), /Entra GUID/);
});
