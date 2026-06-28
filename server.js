const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_DATA_FILE = path.join(ROOT, 'data', 'project.json');
const MAX_BODY_SIZE = 5 * 1024 * 1024;

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

function createApp({ dataFile = DEFAULT_DATA_FILE, publicDir = PUBLIC_DIR } = {}) {
  let saveQueue = Promise.resolve();

  async function readProject() {
    return validateProject(JSON.parse(await fs.readFile(dataFile, 'utf8')));
  }

  async function saveProject(project) {
    const validProject = validateProject(project);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      const tempFile = `${dataFile}.tmp`;
      await fs.writeFile(tempFile, `${JSON.stringify(validProject, null, 2)}\n`, 'utf8');
      await fs.rename(tempFile, dataFile);
    });
    await saveQueue;
    return validProject;
  }

  return async function app(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');

      if (url.pathname === '/api/project' && request.method === 'GET') {
        return send(response, 200, JSON.stringify(await readProject()));
      }

      if (url.pathname === '/api/project' && request.method === 'PUT') {
        const project = await saveProject(JSON.parse(await readBody(request)));
        return send(response, 200, JSON.stringify({ ok: true, project }));
      }

      if (url.pathname === '/api/export' && request.method === 'GET') {
        const project = await readProject();
        const filename = (project.title || 'manuscript').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        response.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename || 'manuscript'}.md"`,
          'Cache-Control': 'no-store'
        });
        return response.end(projectToMarkdown(project));
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
      const status = error instanceof SyntaxError ? 400 : error.message.includes('too large') ? 413 : 500;
      send(response, status, JSON.stringify({ error: status === 500 ? 'Unable to complete the request.' : error.message }));
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  const server = http.createServer(createApp());
  server.listen(port, '127.0.0.1', () => {
    console.log(`Novella is ready at http://localhost:${port}`);
  });
}

module.exports = { createApp, normalizeSceneMarkdown, projectToMarkdown, validateProject };
