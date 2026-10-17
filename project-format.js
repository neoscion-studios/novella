const { normalizeDictionaryEntry, MAX_DICTIONARY_ENTRIES_PER_SCOPE } = require('./proofreading/dictionary');

const PROJECT_FORMAT = 'novella-project';
const PROJECT_FORMAT_VERSION = 1;
const MAX_PROJECT_IMPORT_SIZE = 20 * 1024 * 1024;
const LIMITS = Object.freeze({ chapters: 1000, scenes: 10000, characters: 5000, locations: 5000 });

function invalid(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value;
}

function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw invalid(`${label} contains unsupported field “${unknown[0]}”.`);
  if (missing.length) throw invalid(`${label} is missing required field “${missing[0]}”.`);
}

function string(value, label, maxLength, { pattern, allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  if (!allowEmpty && !value) throw invalid(`${label} cannot be empty.`);
  if (value.length > maxLength) throw invalid(`${label} exceeds ${maxLength.toLocaleString()} characters.`);
  if (pattern && !pattern.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function timestamp(value, label) {
  string(value, label, 40, { allowEmpty: false });
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!isoTimestamp.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(`${label} must be an ISO-8601 timestamp.`);
  }
  return value;
}

function collection(value, label, maximum) {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array.`);
  if (value.length > maximum) throw invalid(`${label} exceeds the limit of ${maximum.toLocaleString()}.`);
  return value;
}

function uniqueId(value, label, ids) {
  const id = string(value, `${label} ID`, 100, { allowEmpty: false, pattern: /^[a-z0-9-]+$/i });
  if (ids.has(id)) throw invalid(`Duplicate project ID “${id}” is not allowed.`);
  ids.add(id);
  return id;
}

function validateScene(value, index, ids) {
  const scene = object(value, `Scene ${index + 1}`);
  exactKeys(scene, ['id', 'title', 'synopsis', 'content'], `Scene ${index + 1}`);
  return {
    id: uniqueId(scene.id, `Scene ${index + 1}`, ids),
    title: string(scene.title, `Scene ${index + 1} title`, 300),
    synopsis: string(scene.synopsis, `Scene ${index + 1} synopsis`, 5000),
    content: string(scene.content, `Scene ${index + 1} content`, 1000000)
  };
}

function validateReference(value, index, kind, ids) {
  const label = `${kind} ${index + 1}`;
  const item = object(value, label);
  exactKeys(item, ['id', 'name', 'role', 'description'], label);
  return {
    id: uniqueId(item.id, label, ids),
    name: string(item.name, `${label} name`, 300),
    role: string(item.role, `${label} role`, 500),
    description: string(item.description, `${label} description`, 50000)
  };
}

function validateProjectDocument(value) {
  const project = object(value, 'Novel project');
  exactKeys(project, ['version', 'title', 'author', 'chapters', 'characters', 'locations'], 'Novel project');
  if (project.version !== 1) throw invalid(`Unsupported novel document version “${project.version}”.`);

  const ids = new Set();
  let sceneCount = 0;
  const chapters = collection(project.chapters, 'Novel chapters', LIMITS.chapters).map((value, chapterIndex) => {
    const label = `Chapter ${chapterIndex + 1}`;
    const chapter = object(value, label);
    exactKeys(chapter, ['id', 'title', 'summary', 'scenes'], label);
    const scenes = collection(chapter.scenes, `${label} scenes`, LIMITS.scenes).map((scene, sceneIndex) => {
      sceneCount += 1;
      if (sceneCount > LIMITS.scenes) throw invalid(`Novel scenes exceed the limit of ${LIMITS.scenes.toLocaleString()}.`);
      return validateScene(scene, sceneIndex, ids);
    });
    return {
      id: uniqueId(chapter.id, label, ids),
      title: string(chapter.title, `${label} title`, 300),
      summary: string(chapter.summary, `${label} summary`, 5000),
      scenes
    };
  });

  return {
    version: 1,
    title: string(project.title, 'Novel title', 200),
    author: string(project.author, 'Novel author', 200),
    chapters,
    characters: collection(project.characters, 'Novel characters', LIMITS.characters)
      .map((item, index) => validateReference(item, index, 'Character', ids)),
    locations: collection(project.locations, 'Novel locations', LIMITS.locations)
      .map((item, index) => validateReference(item, index, 'Location', ids))
  };
}

function validateDictionaryEntries(value) {
  return collection(value, 'Novel dictionary', MAX_DICTIONARY_ENTRIES_PER_SCOPE).map((item, index) => {
    const label = `Novel dictionary entry ${index + 1}`;
    const record = object(item, label);
    exactKeys(record, ['entry', 'createdAt'], label);
    const normalized = normalizeDictionaryEntry(record.entry);
    if (normalized.entry !== record.entry) throw invalid(`${label} must use its normalized display spelling.`);
    return { entry: normalized.entry, createdAt: timestamp(record.createdAt, `${label} createdAt`) };
  }).map((entry, index, entries) => {
    const normalized = normalizeDictionaryEntry(entry.entry).normalized;
    if (entries.findIndex((candidate) => normalizeDictionaryEntry(candidate.entry).normalized === normalized) !== index) {
      throw invalid(`Duplicate novel dictionary entry “${entry.entry}” is not allowed.`);
    }
    return entry;
  });
}

function validateProjectEnvelope(value) {
  const envelope = object(value, 'Project file');
  exactKeys(envelope, ['format', 'version', 'exportedAt', 'novel', 'dictionaries'], 'Project file');
  if (envelope.format !== PROJECT_FORMAT) throw invalid(`Unsupported project format “${envelope.format}”.`);
  if (envelope.version !== PROJECT_FORMAT_VERSION) {
    throw invalid(`Unsupported Novella Project version “${envelope.version}”. This app supports version ${PROJECT_FORMAT_VERSION}.`);
  }
  timestamp(envelope.exportedAt, 'Project exportedAt');

  const novel = object(envelope.novel, 'Project novel');
  exactKeys(novel, ['id', 'createdAt', 'updatedAt', 'project'], 'Project novel');
  const dictionaries = object(envelope.dictionaries, 'Project dictionaries');
  exactKeys(dictionaries, ['novel'], 'Project dictionaries');

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_FORMAT_VERSION,
    exportedAt: envelope.exportedAt,
    novel: {
      id: string(novel.id, 'Project novel ID', 100, { allowEmpty: false, pattern: /^[a-z0-9-]+$/i }),
      createdAt: timestamp(novel.createdAt, 'Project novel createdAt'),
      updatedAt: timestamp(novel.updatedAt, 'Project novel updatedAt'),
      project: validateProjectDocument(novel.project)
    },
    dictionaries: { novel: validateDictionaryEntries(dictionaries.novel) }
  };
}

function createProjectEnvelope(snapshot, exportedAt = new Date().toISOString()) {
  return validateProjectEnvelope({
    format: PROJECT_FORMAT,
    version: PROJECT_FORMAT_VERSION,
    exportedAt,
    novel: {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      project: snapshot.project
    },
    dictionaries: { novel: snapshot.dictionary }
  });
}

function projectImportSummary(envelope) {
  const project = envelope.novel.project;
  return {
    title: project.title,
    author: project.author,
    chapters: project.chapters.length,
    scenes: project.chapters.reduce((total, chapter) => total + chapter.scenes.length, 0),
    characters: project.characters.length,
    locations: project.locations.length,
    dictionaryEntries: envelope.dictionaries.novel.length
  };
}

module.exports = {
  LIMITS,
  MAX_PROJECT_IMPORT_SIZE,
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  createProjectEnvelope,
  projectImportSummary,
  validateProjectDocument,
  validateProjectEnvelope
};
