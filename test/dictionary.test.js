const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SqliteStore } = require('../storage');
const {
  MAX_DICTIONARY_ENTRIES_PER_SCOPE,
  filterDictionaryIssues,
  normalizeDictionaryEntry
} = require('../proofreading/dictionary');

const owner = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  objectId: '22222222-2222-2222-2222-222222222222'
};
const other = { ...owner, objectId: '33333333-3333-3333-3333-333333333333' };
const blankProject = (title) => ({ title, author: '', chapters: [], characters: [], locations: [] });

test('normalizes dictionary words consistently and filters only exact spelling findings', () => {
  assert.deepEqual(normalizeDictionaryEntry('  E\u0301lan  '), { entry: 'Élan', normalized: 'élan' });
  assert.throws(() => normalizeDictionaryEntry('two words'), /single words/);
  assert.throws(() => normalizeDictionaryEntry('word!'), /single words/);

  const issues = [
    { id: 'one', category: 'spelling', original: 'ÉLAN' },
    { id: 'two', category: 'grammar', original: 'Élan' },
    { id: 'three', category: 'spelling', original: 'Élanian' },
    { id: 'four', category: 'spelling', original: 'Other' }
  ];
  assert.deepEqual(
    filterDictionaryIssues(issues, new Set(['élan'])).map((issue) => issue.id),
    ['two', 'three', 'four']
  );
});

test('persists isolated author and novel dictionaries across database restarts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-dictionaries-'));
  const databaseFile = path.join(directory, 'novella.sqlite');
  let store = new SqliteStore(databaseFile);
  t.after(() => store?.close());
  const first = store.create(owner, blankProject('First')).novel.id;
  const second = store.create(owner, blankProject('Second')).novel.id;
  const otherNovel = store.create(other, blankProject('Other')).novel.id;

  assert.deepEqual(store.addDictionaryEntry(owner, first, 'novel', 'Caelion'), { entry: 'Caelion', normalized: 'caelion' });
  assert.deepEqual(store.addDictionaryEntry(owner, first, 'author', 'Myrwood'), { entry: 'Myrwood', normalized: 'myrwood' });
  assert.deepEqual(store.dictionaries(owner, first), {
    author: [{ entry: 'Myrwood', normalized: 'myrwood' }],
    novel: [{ entry: 'Caelion', normalized: 'caelion' }]
  });
  assert.deepEqual(store.dictionaries(owner, second), {
    author: [{ entry: 'Myrwood', normalized: 'myrwood' }],
    novel: []
  });
  assert.deepEqual(store.dictionaries(other, otherNovel), { author: [], novel: [] });
  assert.throws(() => store.dictionaries(other, first), /Novel not found/);
  assert.throws(() => store.addDictionaryEntry(owner, first, 'novel', 'CAELION'), /already in this dictionary/);

  store.close();
  store = new SqliteStore(databaseFile);
  assert.equal(store.dictionaries(owner, first).novel[0].entry, 'Caelion');
  assert.equal(store.dictionaries(owner, second).author[0].entry, 'Myrwood');

  store.deleteDictionaryEntry(owner, first, 'novel', 'caelion');
  assert.deepEqual(store.dictionaries(owner, first).novel, []);
});

test('upgrades a version-one database additively without changing novels', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-dictionary-upgrade-'));
  const databaseFile = path.join(directory, 'novella.sqlite');
  let store = new SqliteStore(databaseFile);
  const novelId = store.create(owner, blankProject('Preserved')).novel.id;
  store.database.exec(`
    DROP TABLE novel_dictionary_entries;
    DROP TABLE author_dictionary_entries;
    PRAGMA user_version = 1;
  `);
  store.close();

  store = new SqliteStore(databaseFile);
  t.after(() => store.close());
  assert.equal(store.read(owner, novelId).title, 'Preserved');
  assert.deepEqual(store.dictionaries(owner, novelId), { author: [], novel: [] });
  assert.equal(store.database.prepare('PRAGMA user_version').get().user_version, 2);
});

test('rejects excessive dictionary entries without losing existing entries', () => {
  const store = new SqliteStore(':memory:');
  const novelId = store.create(owner, blankProject('Limits')).novel.id;
  for (let index = 0; index < MAX_DICTIONARY_ENTRIES_PER_SCOPE; index += 1) {
    store.addDictionaryEntry(owner, novelId, 'novel', `Word${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`);
  }
  assert.throws(() => store.addDictionaryEntry(owner, novelId, 'novel', 'Overflow'), /limited/);
  assert.equal(store.dictionaries(owner, novelId).novel.length, MAX_DICTIONARY_ENTRIES_PER_SCOPE);
  store.close();
});
