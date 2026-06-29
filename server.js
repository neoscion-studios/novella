const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_DATA_FILE = path.join(ROOT, 'data', 'project.json');
const MAX_BODY_SIZE = 5 * 1024 * 1024;
const TTS_MODEL_LIMITS = {
  eleven_v3: 5000,
  eleven_multilingual_v2: 10000,
  eleven_flash_v2: 30000,
  eleven_flash_v2_5: 40000
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function validateProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Project must be a JSON object.');
  }

  const project = {
    version: 1,
    title: cleanText(input.title, 'Untitled novel').slice(0, 200),
    author: cleanText(input.author).slice(0, 200),
    chapters: Array.isArray(input.chapters) ? input.chapters : [],
    characters: Array.isArray(input.characters) ? input.characters : [],
    locations: Array.isArray(input.locations) ? input.locations : []
  };

  project.chapters = project.chapters.map((chapter, chapterIndex) => ({
    id: cleanText(chapter?.id, `chapter-${chapterIndex + 1}`).slice(0, 100),
    title: cleanText(chapter?.title, `Chapter ${chapterIndex + 1}`).slice(0, 300),
    summary: cleanText(chapter?.summary).slice(0, 5000),
    scenes: (Array.isArray(chapter?.scenes) ? chapter.scenes : []).map((scene, sceneIndex) => ({
      id: cleanText(scene?.id, `scene-${chapterIndex + 1}-${sceneIndex + 1}`).slice(0, 100),
      title: cleanText(scene?.title, `Scene ${sceneIndex + 1}`).slice(0, 300),
      synopsis: cleanText(scene?.synopsis).slice(0, 5000),
      content: cleanText(scene?.content).slice(0, 1000000)
    }))
  }));

  const validateReference = (item, index, kind) => ({
    id: cleanText(item?.id, `${kind}-${index + 1}`).slice(0, 100),
    name: cleanText(item?.name, `Untitled ${kind}`).slice(0, 300),
    role: cleanText(item?.role).slice(0, 500),
    description: cleanText(item?.description).slice(0, 50000)
  });

  project.characters = project.characters.map((item, index) => validateReference(item, index, 'character'));
  project.locations = project.locations.map((item, index) => validateReference(item, index, 'location'));
  return project;
}

function projectToMarkdown(project) {
  const lines = [`# ${project.title || 'Untitled novel'}`];
  if (project.author) lines.push('', `*By ${project.author}*`);

  project.chapters.forEach((chapter) => {
    lines.push('', `## ${chapter.title || 'Untitled chapter'}`);
    const writtenScenes = chapter.scenes.filter((scene) => scene.content.trim());
    writtenScenes.forEach((scene, sceneIndex) => {
      if (sceneIndex > 0) lines.push('', '* * *');
      lines.push('', normalizeSceneMarkdown(scene.content.trim()));
    });
  });
  return `${lines.join('\n').trim()}\n`;
}

function normalizeSceneMarkdown(content) {
  let fence = null;
  return content.split('\n').map((line) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      return line;
    }

    if (fence) return line;
    return line.replace(/^(\s{0,3})(#{1,6})(?=\s)/, (_, indent, hashes) => {
      return `${indent}${'#'.repeat(Math.min(6, hashes.length + 2))}`;
    });
  }).join('\n');
}

function plainTextForSpeech(content) {
  return cleanText(content)
    .replace(/^[ \t]*```[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-+*][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

function createApp({
  dataFile = DEFAULT_DATA_FILE,
  dataDir = path.dirname(dataFile),
  publicDir = PUBLIC_DIR,
  fetchImpl = globalThis.fetch,
  ttsConfig = {}
} = {}) {
  const catalogFile = path.join(dataDir, 'catalog.json');
  const novelsDir = path.join(dataDir, 'novels');
  const speech = {
    apiKey: ttsConfig.apiKey ?? process.env.ELEVENLABS_API_KEY ?? '',
    voiceId: ttsConfig.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? '',
    modelId: ttsConfig.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? 'eleven_flash_v2_5',
    enableLogging: String(ttsConfig.enableLogging ?? process.env.ELEVENLABS_ENABLE_LOGGING ?? 'false') === 'true'
  };
  speech.maxCharacters = TTS_MODEL_LIMITS[speech.modelId] || 40000;
  let saveQueue = Promise.resolve();
  let initializationPromise = null;

  const novelFile = (id) => path.join(novelsDir, `${id}.json`);

  async function writeJsonAtomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  }

  function makeBlankProject(title = 'Untitled novel') {
    return {
      version: 1,
      title: cleanText(title, 'Untitled novel').slice(0, 200) || 'Untitled novel',
      author: '',
      chapters: [{
        id: `chapter-${randomUUID()}`,
        title: 'Chapter One',
        summary: '',
        scenes: [{ id: `scene-${randomUUID()}`, title: 'Untitled scene', synopsis: '', content: '' }]
      }],
      characters: [],
      locations: []
    };
  }

  function validateCatalog(input) {
    if (!input || !Array.isArray(input.novels)) throw new Error('Novel catalog is invalid.');
    return {
      version: 1,
      novels: input.novels.filter((novel) => /^[a-z0-9-]{1,100}$/i.test(novel?.id)).map((novel) => ({
        id: novel.id,
        title: cleanText(novel.title, 'Untitled novel').slice(0, 200),
        author: cleanText(novel.author).slice(0, 200),
        createdAt: cleanText(novel.createdAt),
        updatedAt: cleanText(novel.updatedAt)
      }))
    };
  }

  async function initializeCatalog() {
    if (!initializationPromise) initializationPromise = (async () => {
      try {
        return validateCatalog(JSON.parse(await fs.readFile(catalogFile, 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      let firstProject;
      try {
        firstProject = validateProject(JSON.parse(await fs.readFile(dataFile, 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const sampleCatalogFile = path.join(dataDir, 'samples', 'catalog.json');
        try {
          const sampleCatalog = validateCatalog(JSON.parse(await fs.readFile(sampleCatalogFile, 'utf8')));
          if (sampleCatalog.novels.length) {
            for (const summary of sampleCatalog.novels) {
              const sampleFile = path.join(dataDir, 'samples', 'novels', `${summary.id}.json`);
              const sampleProject = validateProject(JSON.parse(await fs.readFile(sampleFile, 'utf8')));
              summary.title = sampleProject.title;
              summary.author = sampleProject.author;
              await writeJsonAtomic(novelFile(summary.id), sampleProject);
            }
            await writeJsonAtomic(catalogFile, sampleCatalog);
            return sampleCatalog;
          }
        } catch (sampleError) {
          if (sampleError.code !== 'ENOENT') throw sampleError;
        }
        firstProject = makeBlankProject();
      }

      const id = `novel-${randomUUID()}`;
      const now = new Date().toISOString();
      const catalog = {
        version: 1,
        novels: [{ id, title: firstProject.title, author: firstProject.author, createdAt: now, updatedAt: now }]
      };
      await writeJsonAtomic(novelFile(id), firstProject);
      await writeJsonAtomic(catalogFile, catalog);
      return catalog;
    })();
    return initializationPromise;
  }

  async function readCatalog() {
    await initializeCatalog();
    return validateCatalog(JSON.parse(await fs.readFile(catalogFile, 'utf8')));
  }

  async function readNovel(id) {
    const catalog = await readCatalog();
    if (!catalog.novels.some((novel) => novel.id === id)) {
      const error = new Error('Novel not found.');
      error.statusCode = 404;
      throw error;
    }
    return validateProject(JSON.parse(await fs.readFile(novelFile(id), 'utf8')));
  }

  async function queueMutation(callback) {
    saveQueue = saveQueue.catch(() => {}).then(callback);
    return saveQueue;
  }

  async function createNovel(input) {
    await initializeCatalog();
    return queueMutation(async () => {
      const catalog = await readCatalog();
      const project = makeBlankProject(input?.title);
      const id = `novel-${randomUUID()}`;
      const now = new Date().toISOString();
      const summary = { id, title: project.title, author: project.author, createdAt: now, updatedAt: now };
      catalog.novels.push(summary);
      await writeJsonAtomic(novelFile(id), project);
      await writeJsonAtomic(catalogFile, catalog);
      return { novel: summary, project };
    });
  }

  async function saveNovel(id, input) {
    await initializeCatalog();
    const project = validateProject(input);
    return queueMutation(async () => {
      const catalog = await readCatalog();
      const summary = catalog.novels.find((novel) => novel.id === id);
      if (!summary) {
        const error = new Error('Novel not found.');
        error.statusCode = 404;
        throw error;
      }
      summary.title = project.title;
      summary.author = project.author;
      summary.updatedAt = new Date().toISOString();
      await writeJsonAtomic(novelFile(id), project);
      await writeJsonAtomic(catalogFile, catalog);
      return { project, novel: summary };
    });
  }

  async function deleteNovel(id) {
    await initializeCatalog();
    return queueMutation(async () => {
      const catalog = await readCatalog();
      const index = catalog.novels.findIndex((novel) => novel.id === id);
      if (index === -1) {
        const error = new Error('Novel not found.');
        error.statusCode = 404;
        throw error;
      }
      if (catalog.novels.length === 1) {
        const error = new Error('At least one novel must remain.');
        error.statusCode = 409;
        throw error;
      }
      catalog.novels.splice(index, 1);
      await writeJsonAtomic(catalogFile, catalog);
      await fs.unlink(novelFile(id)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return catalog;
    });
  }

  return async function app(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return send(response, 200, JSON.stringify({ ok: true }));
      }

      if (url.pathname === '/api/tts/config' && request.method === 'GET') {
        return send(response, 200, JSON.stringify({
          enabled: Boolean(speech.apiKey && speech.voiceId),
          modelId: speech.modelId,
          maxCharacters: speech.maxCharacters
        }));
      }

      if (url.pathname === '/api/tts' && request.method === 'POST') {
        if (!speech.apiKey || !speech.voiceId) {
          const error = new Error('ElevenLabs narration is not configured.');
          error.statusCode = 503;
          throw error;
        }

        const input = JSON.parse(await readBody(request));
        const text = plainTextForSpeech(input?.text);
        if (!text) {
          const error = new Error('This scene has no text to narrate.');
          error.statusCode = 400;
          throw error;
        }
        if (text.length > speech.maxCharacters) {
          const error = new Error(`This scene exceeds the ${speech.maxCharacters.toLocaleString()} character limit for ${speech.modelId}.`);
          error.statusCode = 413;
          throw error;
        }

        const upstreamController = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) upstreamController.abort();
        });
        const upstream = await fetchImpl(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(speech.voiceId)}/stream?output_format=mp3_44100_128&enable_logging=${speech.enableLogging}`,
          {
            method: 'POST',
            signal: upstreamController.signal,
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': speech.apiKey
            },
            body: JSON.stringify({ text, model_id: speech.modelId })
          }
        );

        if (!upstream.ok) {
          const messages = {
            401: 'ElevenLabs rejected the configured API key.',
            402: 'The ElevenLabs account does not have enough credits.',
            422: 'ElevenLabs rejected the selected voice, model, or scene text.',
            429: 'ElevenLabs is rate-limiting narration requests.'
          };
          const error = new Error(messages[upstream.status] || 'ElevenLabs could not generate narration.');
          error.statusCode = upstream.status === 429 ? 429 : 502;
          throw error;
        }

        const audio = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(200, {
          'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
          'Content-Length': audio.length,
          'Cache-Control': 'no-store'
        });
        return response.end(audio);
      }

      if (url.pathname === '/api/novels' && request.method === 'GET') {
        return send(response, 200, JSON.stringify(await readCatalog()));
      }

      if (url.pathname === '/api/novels' && request.method === 'POST') {
        const body = await readBody(request);
        return send(response, 201, JSON.stringify(await createNovel(body ? JSON.parse(body) : {})));
      }

      const novelRoute = url.pathname.match(/^\/api\/novels\/([a-z0-9-]+)(\/export)?$/i);
      if (novelRoute && novelRoute[2] && request.method === 'GET') {
        const project = await readNovel(novelRoute[1]);
        const filename = (project.title || 'manuscript').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        response.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename || 'manuscript'}.md"`,
          'Cache-Control': 'no-store'
        });
        return response.end(projectToMarkdown(project));
      }

      if (novelRoute && !novelRoute[2] && request.method === 'GET') {
        return send(response, 200, JSON.stringify(await readNovel(novelRoute[1])));
      }

      if (novelRoute && !novelRoute[2] && request.method === 'PUT') {
        return send(response, 200, JSON.stringify(await saveNovel(novelRoute[1], JSON.parse(await readBody(request)))));
      }

      if (novelRoute && !novelRoute[2] && request.method === 'DELETE') {
        return send(response, 200, JSON.stringify(await deleteNovel(novelRoute[1])));
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return send(response, 405, JSON.stringify({ error: 'Method not allowed.' }));
      }

      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.resolve(publicDir, requested);
      if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
        return send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
      }

      try {
        const file = await fs.readFile(filePath);
        response.writeHead(200, {
          'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
          'Cache-Control': path.extname(filePath) === '.html' ? 'no-store' : 'public, max-age=300'
        });
        return response.end(request.method === 'HEAD' ? undefined : file);
      } catch (error) {
        if (error.code === 'ENOENT') return send(response, 404, 'Not found', 'text/plain; charset=utf-8');
        throw error;
      }
    } catch (error) {
      if (error.name === 'AbortError' && (response.destroyed || response.writableEnded)) return;
      const status = error.statusCode || (error instanceof SyntaxError ? 400 : error.message.includes('too large') ? 413 : 500);
      send(response, status, JSON.stringify({ error: status === 500 ? 'Unable to complete the request.' : error.message }));
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  const host = process.env.HOST || '127.0.0.1';
  const server = http.createServer(createApp());
  server.listen(port, host, () => {
    console.log(`Novella is ready on http://${host}:${port}`);
  });
}

module.exports = { createApp, normalizeSceneMarkdown, plainTextForSpeech, projectToMarkdown, validateProject };
