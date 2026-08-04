#!/usr/bin/env node

const path = require('node:path');
const { loadLegacyRecords } = require('../legacy-import');
const { SqliteStore } = require('../storage');

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument.startsWith('--') || !values[index + 1] || values[index + 1].startsWith('--')) {
      throw new Error(`Expected a value after ${argument}.`);
    }
    options[argument.slice(2)] = values[index + 1];
    index += 1;
  }
  return options;
}

function requireGuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')) {
    throw new Error(`${label} must be an Entra GUID.`);
  }
  return value.toLowerCase();
}

async function main(values = process.argv.slice(2)) {
  const options = parseArguments(values);
  const dataDir = path.resolve(options['data-dir'] || path.join(__dirname, '..', 'data'));
  const databaseFile = path.resolve(options.database || process.env.DATABASE_FILE || path.join(dataDir, 'novella.sqlite'));
  const identity = {
    tenantId: requireGuid(options['tenant-id'], '--tenant-id'),
    objectId: requireGuid(options['object-id'], '--object-id'),
    name: options.name || '',
    username: options.email || ''
  };
  const records = await loadLegacyRecords({ dataDir });
  if (!records.length) throw new Error(`No legacy catalog or project file was found under ${dataDir}.`);

  const store = new SqliteStore(databaseFile);
  try {
    const result = store.import(identity, records);
    process.stdout.write(
      `SQLite import complete: ${result.imported} imported, ${result.skipped} already present. Legacy JSON files were left unchanged.\n`
    );
    return result;
  } finally {
    store.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Import failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, requireGuid };
