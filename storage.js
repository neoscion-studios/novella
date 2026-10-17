const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { MAX_DICTIONARY_ENTRIES_PER_SCOPE, normalizeDictionaryEntry } = require('./proofreading/dictionary');

function notFound() {
  const error = new Error('Novel not found.');
  error.statusCode = 404;
  return error;
}

function dictionaryNotFound() {
  const error = new Error('Dictionary entry not found.');
  error.statusCode = 404;
  return error;
}

function summary(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateIdentity(identity) {
  if (!identity || typeof identity.tenantId !== 'string' || !identity.tenantId) {
    throw new Error('Authenticated tenant identity is required.');
  }
  if (typeof identity.objectId !== 'string' || !identity.objectId) {
    throw new Error('Authenticated object identity is required.');
  }
}

class SqliteStore {
  constructor(databaseFile) {
    this.databaseFile = databaseFile;
    if (databaseFile !== ':memory:') fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.database = new DatabaseSync(databaseFile, { timeout: 5000 });
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, object_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS novels (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        project_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS novels_user_updated
        ON novels(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS author_dictionary_entries (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        normalized_entry TEXT NOT NULL,
        display_entry TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, normalized_entry)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS novel_dictionary_entries (
        user_id INTEGER NOT NULL,
        novel_id TEXT NOT NULL,
        normalized_entry TEXT NOT NULL,
        display_entry TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, novel_id, normalized_entry),
        FOREIGN KEY (user_id, novel_id) REFERENCES novels(user_id, id) ON DELETE CASCADE
      ) STRICT;
    `);
    const schemaVersion = this.database.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion < 2) this.database.exec('PRAGMA user_version = 2');

    this.statements = {
      insertUser: this.database.prepare(`
        INSERT OR IGNORE INTO users
          (tenant_id, object_id, display_name, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      selectUser: this.database.prepare(`
        SELECT id, tenant_id, object_id, display_name, email
        FROM users WHERE tenant_id = ? AND object_id = ?
      `),
      updateUser: this.database.prepare(`
        UPDATE users SET display_name = ?, email = ?, updated_at = ?
        WHERE id = ? AND (display_name <> ? OR email <> ?)
      `),
      countNovels: this.database.prepare('SELECT COUNT(*) AS count FROM novels WHERE user_id = ?'),
      listNovels: this.database.prepare(`
        SELECT id, title, author, created_at, updated_at
        FROM novels WHERE user_id = ? ORDER BY created_at, id
      `),
      selectNovel: this.database.prepare(`
        SELECT project_json FROM novels WHERE user_id = ? AND id = ?
      `),
      selectNovelRecord: this.database.prepare(`
        SELECT id, project_json, created_at, updated_at
        FROM novels WHERE user_id = ? AND id = ?
      `),
      insertNovel: this.database.prepare(`
        INSERT INTO novels
          (user_id, id, title, author, project_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      updateNovel: this.database.prepare(`
        UPDATE novels SET title = ?, author = ?, project_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ?
      `),
      deleteNovel: this.database.prepare('DELETE FROM novels WHERE user_id = ? AND id = ?'),
      listAuthorDictionary: this.database.prepare(`
        SELECT display_entry AS entry, normalized_entry AS normalized
        FROM author_dictionary_entries WHERE user_id = ? ORDER BY normalized_entry
      `),
      listNovelDictionary: this.database.prepare(`
        SELECT display_entry AS entry, normalized_entry AS normalized
        FROM novel_dictionary_entries WHERE user_id = ? AND novel_id = ? ORDER BY normalized_entry
      `),
      exportNovelDictionary: this.database.prepare(`
        SELECT display_entry AS entry, created_at AS createdAt
        FROM novel_dictionary_entries WHERE user_id = ? AND novel_id = ? ORDER BY normalized_entry
      `),
      countAuthorDictionary: this.database.prepare('SELECT COUNT(*) AS count FROM author_dictionary_entries WHERE user_id = ?'),
      countNovelDictionary: this.database.prepare('SELECT COUNT(*) AS count FROM novel_dictionary_entries WHERE user_id = ? AND novel_id = ?'),
      selectAuthorDictionaryEntry: this.database.prepare('SELECT display_entry AS entry, normalized_entry AS normalized FROM author_dictionary_entries WHERE user_id = ? AND normalized_entry = ?'),
      selectNovelDictionaryEntry: this.database.prepare('SELECT display_entry AS entry, normalized_entry AS normalized FROM novel_dictionary_entries WHERE user_id = ? AND novel_id = ? AND normalized_entry = ?'),
      insertAuthorDictionaryEntry: this.database.prepare('INSERT INTO author_dictionary_entries (user_id, normalized_entry, display_entry, created_at) VALUES (?, ?, ?, ?)'),
      insertNovelDictionaryEntry: this.database.prepare('INSERT INTO novel_dictionary_entries (user_id, novel_id, normalized_entry, display_entry, created_at) VALUES (?, ?, ?, ?, ?)'),
      deleteAuthorDictionaryEntry: this.database.prepare('DELETE FROM author_dictionary_entries WHERE user_id = ? AND normalized_entry = ?'),
      deleteNovelDictionaryEntry: this.database.prepare('DELETE FROM novel_dictionary_entries WHERE user_id = ? AND novel_id = ? AND normalized_entry = ?')
    };
  }

  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  userFor(identity) {
    validateIdentity(identity);
    const now = new Date().toISOString();
    const name = typeof identity.name === 'string' ? identity.name.slice(0, 200) : '';
    const email = typeof identity.username === 'string' ? identity.username.slice(0, 320) : '';
    this.statements.insertUser.run(identity.tenantId, identity.objectId, name, email, now, now);
    const user = this.statements.selectUser.get(identity.tenantId, identity.objectId);
    this.statements.updateUser.run(name, email, now, user.id, name, email);
    return user;
  }

  count(identity) {
    const user = this.userFor(identity);
    return this.statements.countNovels.get(user.id).count;
  }

  seedIfEmpty(identity, records) {
    const user = this.userFor(identity);
    return this.transaction(() => {
      if (this.statements.countNovels.get(user.id).count > 0) return false;
      for (const record of records) this.insertRecord(this.statements.insertNovel, user.id, record);
      return true;
    });
  }

  catalog(identity) {
    const user = this.userFor(identity);
    return { version: 1, novels: this.statements.listNovels.all(user.id).map(summary) };
  }

  read(identity, id) {
    const user = this.userFor(identity);
    const row = this.statements.selectNovel.get(user.id, id);
    if (!row) throw notFound();
    return JSON.parse(row.project_json);
  }

  exportProject(identity, id) {
    const user = this.userFor(identity);
    return this.transaction(() => {
      const row = this.statements.selectNovelRecord.get(user.id, id);
      if (!row) throw notFound();
      return {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        project: JSON.parse(row.project_json),
        dictionary: this.statements.exportNovelDictionary.all(user.id, id)
      };
    });
  }

  create(identity, project) {
    const user = this.userFor(identity);
    const now = new Date().toISOString();
    const record = {
      id: `novel-${randomUUID()}`,
      project,
      createdAt: now,
      updatedAt: now
    };
    this.insertRecord(this.statements.insertNovel, user.id, record);
    return { novel: summary({
      id: record.id,
      title: project.title,
      author: project.author,
      created_at: now,
      updated_at: now
    }), project };
  }

  importProject(identity, envelope) {
    const user = this.userFor(identity);
    return this.transaction(() => {
      let id;
      do id = `novel-${randomUUID()}`;
      while (this.statements.selectNovel.get(user.id, id));

      const project = envelope.novel.project;
      const record = {
        id,
        project,
        createdAt: envelope.novel.createdAt,
        updatedAt: envelope.novel.updatedAt
      };
      this.insertRecord(this.statements.insertNovel, user.id, record);
      for (const entry of envelope.dictionaries.novel) {
        const normalized = normalizeDictionaryEntry(entry.entry);
        this.statements.insertNovelDictionaryEntry.run(
          user.id,
          id,
          normalized.normalized,
          normalized.entry,
          entry.createdAt
        );
      }
      return {
        novel: summary({
          id,
          title: project.title,
          author: project.author,
          created_at: record.createdAt,
          updated_at: record.updatedAt
        }),
        project
      };
    });
  }

  save(identity, id, project) {
    const user = this.userFor(identity);
    const updatedAt = new Date().toISOString();
    const result = this.statements.updateNovel.run(
      project.title,
      project.author,
      JSON.stringify(project),
      updatedAt,
      user.id,
      id
    );
    if (result.changes === 0) throw notFound();
    const row = this.statements.listNovels.all(user.id).find((novel) => novel.id === id);
    return { project, novel: summary(row) };
  }

  delete(identity, id) {
    const user = this.userFor(identity);
    return this.transaction(() => {
      const count = this.statements.countNovels.get(user.id).count;
      if (!this.statements.selectNovel.get(user.id, id)) throw notFound();
      if (count === 1) {
        const error = new Error('At least one novel must remain.');
        error.statusCode = 409;
        throw error;
      }
      this.statements.deleteNovel.run(user.id, id);
      return { version: 1, novels: this.statements.listNovels.all(user.id).map(summary) };
    });
  }

  dictionaries(identity, novelId) {
    const user = this.userFor(identity);
    if (!this.statements.selectNovel.get(user.id, novelId)) throw notFound();
    const entries = (rows) => rows.map((row) => ({ entry: row.entry, normalized: row.normalized }));
    return {
      author: entries(this.statements.listAuthorDictionary.all(user.id)),
      novel: entries(this.statements.listNovelDictionary.all(user.id, novelId))
    };
  }

  addDictionaryEntry(identity, novelId, scope, value) {
    const user = this.userFor(identity);
    if (!this.statements.selectNovel.get(user.id, novelId)) throw notFound();
    if (scope !== 'author' && scope !== 'novel') {
      const error = new Error('Dictionary scope must be author or novel.');
      error.statusCode = 400;
      throw error;
    }
    const normalized = normalizeDictionaryEntry(value);
    const select = scope === 'author' ? this.statements.selectAuthorDictionaryEntry : this.statements.selectNovelDictionaryEntry;
    const selectArgs = scope === 'author' ? [user.id, normalized.normalized] : [user.id, novelId, normalized.normalized];
    if (select.get(...selectArgs)) {
      const error = new Error('That word is already in this dictionary.');
      error.statusCode = 409;
      throw error;
    }
    const count = scope === 'author'
      ? this.statements.countAuthorDictionary.get(user.id).count
      : this.statements.countNovelDictionary.get(user.id, novelId).count;
    if (count >= MAX_DICTIONARY_ENTRIES_PER_SCOPE) {
      const error = new Error(`This dictionary is limited to ${MAX_DICTIONARY_ENTRIES_PER_SCOPE} entries.`);
      error.statusCode = 409;
      throw error;
    }
    const now = new Date().toISOString();
    if (scope === 'author') this.statements.insertAuthorDictionaryEntry.run(user.id, normalized.normalized, normalized.entry, now);
    else this.statements.insertNovelDictionaryEntry.run(user.id, novelId, normalized.normalized, normalized.entry, now);
    return normalized;
  }

  deleteDictionaryEntry(identity, novelId, scope, value) {
    const user = this.userFor(identity);
    if (!this.statements.selectNovel.get(user.id, novelId)) throw notFound();
    if (scope !== 'author' && scope !== 'novel') {
      const error = new Error('Dictionary scope must be author or novel.');
      error.statusCode = 400;
      throw error;
    }
    const { normalized } = normalizeDictionaryEntry(value);
    const result = scope === 'author'
      ? this.statements.deleteAuthorDictionaryEntry.run(user.id, normalized)
      : this.statements.deleteNovelDictionaryEntry.run(user.id, novelId, normalized);
    if (result.changes === 0) throw dictionaryNotFound();
    return this.dictionaries(identity, novelId);
  }

  import(identity, records) {
    const user = this.userFor(identity);
    return this.transaction(() => {
      let imported = 0;
      let skipped = 0;
      for (const record of records) {
        const existing = this.statements.selectNovel.get(user.id, record.id);
        if (existing) {
          if (existing.project_json !== JSON.stringify(record.project)) {
            throw new Error(`Novel ${record.id} already exists with different content; import was not changed.`);
          }
          skipped += 1;
          continue;
        }
        this.insertRecord(this.statements.insertNovel, user.id, record);
        imported += 1;
      }
      return { imported, skipped };
    });
  }

  insertRecord(statement, userId, record) {
    return statement.run(
      userId,
      record.id,
      record.project.title,
      record.project.author,
      JSON.stringify(record.project),
      record.createdAt,
      record.updatedAt
    );
  }

  close() {
    this.database.close();
  }
}

module.exports = { SqliteStore, validateIdentity };
