const fs = require('node:fs/promises');
const path = require('node:path');
const { validateProject } = require('./server');

function safeDate(value, fallback) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

async function loadLegacyRecords({ dataDir, dataFile = path.join(dataDir, 'project.json') }) {
  const catalogFile = path.join(dataDir, 'catalog.json');
  try {
    const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
    if (!catalog || !Array.isArray(catalog.novels)) throw new Error('Legacy catalog is invalid.');
    const records = [];
    for (const entry of catalog.novels) {
      if (!/^[a-z0-9-]{1,100}$/i.test(entry?.id)) {
        throw new Error('Legacy catalog contains an invalid novel ID.');
      }
      const file = path.join(dataDir, 'novels', `${entry.id}.json`);
      const project = validateProject(JSON.parse(await fs.readFile(file, 'utf8')));
      const stats = await fs.stat(file);
      const fallback = stats.mtime.toISOString();
      records.push({
        id: entry.id,
        project,
        createdAt: safeDate(entry.createdAt, fallback),
        updatedAt: safeDate(entry.updatedAt, fallback)
      });
    }
    return records;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    const project = validateProject(JSON.parse(await fs.readFile(dataFile, 'utf8')));
    const stats = await fs.stat(dataFile);
    const timestamp = stats.mtime.toISOString();
    return [{ id: 'legacy-project', project, createdAt: timestamp, updatedAt: timestamp }];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

module.exports = { loadLegacyRecords };
