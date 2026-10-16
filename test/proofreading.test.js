const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createApp } = require('../server');
const { createLanguageToolAdapter } = require('../proofreading/languagetool-adapter');
const { mapProjectionSpan, projectMarkdown } = require('../proofreading/markdown-projection');
const { adjacentIssue, applyReplacement, canApply, dictionaryWord, responseMatches, runSequential } = require('../public/proofreading');

const testApps = new Map();
let nextPort = 43000;

function request(input, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    const app = testApps.get(Number(url.port));
    const incoming = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    incoming.url = `${url.pathname}${url.search}`;
    incoming.method = options.method || 'GET';
    incoming.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    let status = 200;
    let headers = {};
    const outgoing = {
      writableEnded: false,
      destroyed: false,
      once: () => outgoing,
      writeHead(code, values = {}) { status = code; headers = values; },
      end(value = '') {
        outgoing.writableEnded = true;
        const body = Buffer.from(value || '');
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name) => Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null },
          text: async () => body.toString('utf8'),
          json: async () => JSON.parse(body.toString('utf8')),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        });
      }
    };
    Promise.resolve(app(incoming, outgoing)).catch(reject);
  });
}

async function startApp(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-proofreading-'));
  const app = createApp({ dataDir: directory, ...options });
  const port = nextPort++;
  testApps.set(port, app);
  return {
    server: { close() { testApps.delete(port); app.close(); } },
    base: `http://127.0.0.1:${port}`
  };
}

test('projects Markdown while retaining exact UTF-16 source offsets', () => {
  const source = '# 😀 A **mispeling** [label](https://example.test)\n\n```js\nmispeling\n```\nVisit https://example.test/mispeling';
  const projection = projectMarkdown(source);
  assert.equal(projection.text.includes('😀 A mispeling label'), true);
  assert.equal(projection.text.includes('example.test'), false);
  assert.equal(projection.text.match(/mispeling/g).length, 1);

  const offset = projection.text.indexOf('mispeling');
  const span = mapProjectionSpan(projection, offset, 'mispeling'.length, source);
  assert.deepEqual(span, {
    start: source.indexOf('mispeling'),
    end: source.indexOf('mispeling') + 'mispeling'.length,
    original: 'mispeling',
    applicable: true
  });

  const phraseOffset = projection.text.indexOf('A mispeling');
  assert.equal(mapProjectionSpan(projection, phraseOffset, 'A mispeling'.length, source).applicable, false);
});

test('normalizes spelling and grammar matches without leaking provider payloads', async () => {
  let upstreamBody;
  const adapter = createLanguageToolAdapter({
    url: 'http://checker.internal:8010',
    fetchImpl: async (_url, options) => {
      upstreamBody = new URLSearchParams(options.body);
      return new Response(JSON.stringify({
        matches: [
          { offset: 0, length: 3, message: 'Possible spelling mistake', replacements: [{ value: 'The' }], rule: { id: 'SPELL', issueType: 'misspelling' } },
          { offset: 4, length: 8, message: 'Agreement problem', replacements: [{ value: 'walks' }], rule: { id: 'AGREE', issueType: 'grammar' } }
        ],
        secretProviderField: 'not returned'
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  });
  const issues = await adapter.check({ text: 'Teh walk home.', language: 'en-US' });
  assert.equal(upstreamBody.get('text'), 'Teh walk home.');
  assert.deepEqual(issues.map((issue) => issue.category), ['spelling', 'grammar']);
  assert.deepEqual(issues.map((issue) => issue.original), ['Teh', 'walk hom']);
  assert.equal(JSON.stringify(issues).includes('secretProviderField'), false);
});

test('rejects malformed and timed-out checker responses', async () => {
  const malformed = createLanguageToolAdapter({
    url: 'http://checker.internal:8010',
    fetchImpl: async () => new Response('{"unexpected":true}')
  });
  await assert.rejects(malformed.check({ text: 'Text', language: 'en-US' }), /Malformed proofreading response/);

  const timedOut = createLanguageToolAdapter({
    url: 'http://checker.internal:8010',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('private timeout'), { name: 'AbortError' })), { once: true });
    })
  });
  await assert.rejects(timedOut.check({ text: 'Text', language: 'en-US' }), { name: 'AbortError' });
});

test('accept applies only to the exact novel, scene, snapshot, and substring', () => {
  const events = [];
  const textarea = {
    value: 'A **mispeling** stays.',
    focus() {},
    setSelectionRange() {},
    setRangeText(value, start, end) { this.value = this.value.slice(0, start) + value + this.value.slice(end); },
    dispatchEvent(event) { events.push(event.type); }
  };
  const start = textarea.value.indexOf('mispeling');
  const issue = { start, end: start + 9, original: 'mispeling', applicable: true };
  const review = { novelId: 'novel-1', sceneId: 'scene-1', snapshot: textarea.value };
  assert.equal(applyReplacement(textarea, review, issue, 'misspelling', 'novel-1', 'scene-1'), true);
  assert.equal(textarea.value, 'A **misspelling** stays.');
  assert.deepEqual(events, ['input']);

  const staleText = textarea.value;
  assert.equal(canApply(review, issue, 'novel-1', 'scene-1', staleText), false);
  assert.equal(canApply(review, issue, 'novel-1', 'scene-2', review.snapshot), false);
  assert.equal(applyReplacement(textarea, review, issue, 'wrong', 'novel-2', 'scene-1'), false);
  assert.equal(textarea.value, staleText);
  assert.equal(responseMatches(4, 5, 'novel-1', 'novel-1'), false);
  assert.equal(responseMatches(5, 5, 'novel-1', 'novel-2'), false);
});

test('dictionary actions accept only spelling words and issue navigation crosses scenes safely', () => {
  assert.equal(dictionaryWord({ category: 'spelling', original: '  Caelion  ' }), 'Caelion');
  assert.equal(dictionaryWord({ category: 'grammar', original: 'Caelion' }), null);
  assert.equal(dictionaryWord({ category: 'spelling', original: 'two words' }), null);
  const reviews = [
    { sceneId: 's1', issues: [{ id: 'a' }, { id: 'b' }] },
    { sceneId: 's2', issues: [{ id: 'c' }] }
  ];
  assert.deepEqual(adjacentIssue(reviews, { sceneId: 's1', issueId: 'b' }, 1), { sceneId: 's2', issueId: 'c' });
  assert.deepEqual(adjacentIssue(reviews, { sceneId: 's1', issueId: 'a' }, -1), { sceneId: 's2', issueId: 'c' });
});

test('chapter work is sequential, reports progress, and stops safely on unavailability', async () => {
  let active = 0;
  let maxActive = 0;
  const visited = [];
  const progress = [];
  const completed = await runSequential(
    ['s1', 's2', 's3'],
    async (sceneId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      visited.push(sceneId);
      active -= 1;
      return sceneId !== 's2';
    },
    (available) => !available,
    (count, total) => progress.push([count, total])
  );
  assert.equal(maxActive, 1);
  assert.equal(completed, 2);
  assert.deepEqual(visited, ['s1', 's2']);
  assert.deepEqual(progress, [[1, 3], [2, 3]]);
});

test('proofreading API authorizes scenes, uses unsaved snapshots, and degrades safely', async (t) => {
  const calls = [];
  const { server, base } = await startApp({
    proofreadingConfig: { enabled: true, language: 'en-US' },
    proofreadingAdapter: { check: async (input) => {
      calls.push(input);
      return [{ id: 'one', category: 'spelling', message: 'Typo', start: 0, end: 3, original: 'Teh', replacements: [{ value: 'The' }], provider: 'test', applicable: true }];
    } }
  });
  t.after(() => server.close());
  const catalog = await request(`${base}/api/novels`).then((response) => response.json());
  const novelId = catalog.novels[0].id;
  const novel = await request(`${base}/api/novels/${novelId}`).then((response) => response.json());
  const sceneId = novel.chapters[0].scenes[0].id;
  const response = await request(`${base}/api/proofreading/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, sceneId, text: 'Teh unsaved snapshot.', language: 'en-US' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'available');
  assert.deepEqual(calls, [{ text: 'Teh unsaved snapshot.', language: 'en-US' }]);
  assert.equal((await request(`${base}/api/novels/${novelId}`).then((item) => item.json())).chapters[0].scenes[0].content, '');

  const missing = await request(`${base}/api/proofreading/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, sceneId: 'not-owned', text: 'Text' })
  });
  assert.equal(missing.status, 404);
});

test('complete API pipeline sends the full Markdown projection and maps provider offsets to source', async (t) => {
  const passage = await fs.readFile(path.join(__dirname, 'fixtures', 'proofreading-diagnostic.md'), 'utf8');
  let upstream;
  const fetchImpl = async (url, options) => {
    const body = new URLSearchParams(options.body);
    upstream = { url, options, text: body.get('text'), language: body.get('language') };
    const typoOffset = upstream.text.indexOf('teh old');
    const grammarOffset = upstream.text.indexOf('Caelion walk');
    return new Response(JSON.stringify({ matches: [
      { offset: typoOffset, length: 3, message: 'Possible spelling mistake', replacements: [{ value: 'the' }], rule: { id: 'MORFOLOGIK_RULE_EN_US', issueType: 'misspelling' } },
      { offset: grammarOffset, length: 'Caelion walk'.length, message: 'Agreement problem', replacements: [{ value: 'Caelion walks' }], rule: { id: 'SUBJECT_VERB_AGREEMENT', issueType: 'grammar' } }
    ] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const { server, base } = await startApp({
    fetchImpl,
    proofreadingConfig: { enabled: true, url: 'http://checker.internal:8010', language: 'en-US' }
  });
  t.after(() => server.close());
  const catalog = await request(`${base}/api/novels`).then((response) => response.json());
  const novelId = catalog.novels[0].id;
  const novel = await request(`${base}/api/novels/${novelId}`).then((response) => response.json());
  const sceneId = novel.chapters[0].scenes[0].id;
  const result = await request(`${base}/api/proofreading/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, sceneId, text: passage, language: 'en-US' })
  }).then((response) => response.json());

  assert.equal(upstream.url, 'http://checker.internal:8010/v2/check');
  assert.equal(upstream.options.method, 'POST');
  assert.equal(upstream.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(upstream.language, 'en-US');
  assert.equal(upstream.text, projectMarkdown(passage).text);
  assert.equal(upstream.text.includes('example.test'), false);
  assert.equal(upstream.text.includes('teh_code'), false);
  assert.equal(upstream.text.includes('deliberately skipped inside a fence'), false);
  assert.match(upstream.text, /Visit and keep unchanged\./);
  assert.doesNotMatch(upstream.text, /Visit {2,}|keep {2,}/);
  assert.deepEqual(result.issues.map((issue) => ({ category: issue.category, original: issue.original })), [
    { category: 'spelling', original: 'teh' },
    { category: 'grammar', original: 'Caelion walk' }
  ]);
  assert.equal(passage.slice(result.issues[0].start, result.issues[0].end), 'teh');
  assert.equal(passage.slice(result.issues[1].start, result.issues[1].end), 'Caelion walk');
});

test('dictionary APIs filter exact spelling findings without suppressing grammar', async (t) => {
  const issues = [
    { id: 'spell', category: 'spelling', message: 'Unknown word', start: 0, end: 7, original: 'Caelion', replacements: [], provider: 'test', applicable: true },
    { id: 'grammar', category: 'grammar', message: 'Agreement', start: 8, end: 11, original: 'are', replacements: [{ value: 'is' }], provider: 'test', applicable: true },
    { id: 'longer', category: 'spelling', message: 'Unknown word', start: 12, end: 22, original: 'Caelionian', replacements: [], provider: 'test', applicable: true }
  ];
  const { server, base } = await startApp({
    proofreadingConfig: { enabled: true },
    proofreadingAdapter: { check: async () => issues }
  });
  t.after(() => server.close());
  const catalog = await request(`${base}/api/novels`).then((response) => response.json());
  const novelId = catalog.novels[0].id;
  const novel = await request(`${base}/api/novels/${novelId}`).then((response) => response.json());
  const sceneId = novel.chapters[0].scenes[0].id;

  const added = await request(`${base}/api/proofreading/dictionaries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, scope: 'novel', entry: 'Caelion' })
  });
  assert.equal(added.status, 201);
  assert.deepEqual((await added.json()).dictionaries.novel, [{ entry: 'Caelion', normalized: 'caelion' }]);

  const checked = await request(`${base}/api/proofreading/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, sceneId, text: 'Caelion are Caelionian' })
  }).then((response) => response.json());
  assert.deepEqual(checked.issues.map((issue) => issue.id), ['grammar', 'longer']);

  const duplicate = await request(`${base}/api/proofreading/dictionaries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, scope: 'novel', entry: 'CAELION' })
  });
  assert.equal(duplicate.status, 409);
  const invalid = await request(`${base}/api/proofreading/dictionaries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, scope: 'novel', entry: 'two words' })
  });
  assert.equal(invalid.status, 400);

  const removed = await request(`${base}/api/proofreading/dictionaries`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, scope: 'novel', entry: 'caelion' })
  });
  assert.equal(removed.status, 200);
  const rechecked = await request(`${base}/api/proofreading/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, sceneId, text: 'Caelion are Caelionian' })
  }).then((response) => response.json());
  assert.deepEqual(rechecked.issues.map((issue) => issue.id), ['spell', 'grammar', 'longer']);

  await request(`${base}/api/proofreading/dictionaries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId, scope: 'author', entry: 'Caelion' })
  });
  const second = await request(`${base}/api/novels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Second' })
  }).then((response) => response.json());
  const secondCheck = await request(`${base}/api/proofreading/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      novelId: second.novel.id,
      sceneId: second.project.chapters[0].scenes[0].id,
      text: 'Caelion are Caelionian'
    })
  }).then((response) => response.json());
  assert.deepEqual(secondCheck.issues.map((issue) => issue.id), ['grammar', 'longer']);
});

test('disabled and failed checkers leave proofreading requests safe and usable', async (t) => {
  const disabled = await startApp({ proofreadingConfig: { enabled: false } });
  const failed = await startApp({
    proofreadingConfig: { enabled: true },
    proofreadingAdapter: { check: async () => { throw new Error('private upstream detail'); } }
  });
  const misconfigured = await startApp({ proofreadingConfig: { enabled: true, url: 'not a URL' } });
  t.after(() => disabled.server.close());
  t.after(() => failed.server.close());
  t.after(() => misconfigured.server.close());

  for (const [instance, status] of [[disabled, 'disabled'], [failed, 'unavailable'], [misconfigured, 'unavailable']]) {
    const catalog = await request(`${instance.base}/api/novels`).then((response) => response.json());
    const novelId = catalog.novels[0].id;
    const novel = await request(`${instance.base}/api/novels/${novelId}`).then((response) => response.json());
    const sceneId = novel.chapters[0].scenes[0].id;
    const result = await request(`${instance.base}/api/proofreading/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ novelId, sceneId, text: 'Text' })
    }).then((response) => response.json());
    assert.deepEqual(result, { issues: [], status });
    assert.equal(JSON.stringify(result).includes('private upstream detail'), false);
    assert.deepEqual(await request(`${instance.base}/api/health`).then((response) => response.json()), { ok: true });
  }
  const catalog = await request(`${disabled.base}/api/novels`).then((response) => response.json());
  const disabledAdd = await request(`${disabled.base}/api/proofreading/dictionaries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novelId: catalog.novels[0].id, scope: 'author', entry: 'Caelion' })
  });
  assert.equal(disabledAdd.status, 201);
});

test('Compose connects only Novella to shared Caddy and keeps LanguageTool private', async () => {
  const compose = await fs.readFile(path.join(__dirname, '..', 'compose.yaml'), 'utf8');
  const application = compose.slice(compose.indexOf('  novella:'), compose.indexOf('  languagetool:'));
  const checker = compose.slice(compose.indexOf('  languagetool:'), compose.indexOf('\nnetworks:'));
  assert.match(application, /user: "\$\{NOVELLA_UID:-1000\}:\$\{NOVELLA_GID:-1000\}"/);
  assert.match(application, /read_only: true/);
  assert.match(application, /web:\n\s+aliases:\n\s+- novella-app/);
  assert.match(application, /proofreading: \{\}/);
  assert.doesNotMatch(application, /\n\s+ports:/);
  assert.doesNotMatch(application, /\n\s+labels:/);
  assert.match(checker, /image: erikvl87\/languagetool:6\.8@sha256:[a-f0-9]{64}/);
  assert.match(checker, /read_only: true/);
  assert.match(checker, /- proofreading/);
  assert.doesNotMatch(checker, /\n\s+ports:/);
  assert.doesNotMatch(checker, /- web/);
  assert.doesNotMatch(checker, /NOVELLA_(?:UID|GID)/);
  assert.match(compose, /web:\n\s+name: web\n\s+external: true/);
  assert.match(compose, /proofreading:\n\s+name: novella_proofreading\n\s+internal: true/);
  assert.doesNotMatch(compose, /traefik|letsencrypt|docker\.sock|ACME_EMAIL|NOVELLA_HOST/iu);
  const dockerfile = await fs.readFile(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --chown=node:node proofreading \.\/proofreading/);
  assert.doesNotMatch(dockerfile, /(?:ARG|ENV) NOVELLA_(?:UID|GID)/);
});

test('current browser assets expose proofreading and dictionary controls without a browser-specific dependency', async () => {
  const index = await fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appSource = await fs.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(index.indexOf('/proofreading.js') < index.indexOf('/app.js'));
  assert.match(appSource, /spellcheck="true"/);
  assert.match(appSource, /data-proofread-previous/);
  assert.match(appSource, /data-proofread-next/);
  assert.match(appSource, /data-dictionary-toggle/);
  assert.doesNotMatch(appSource, /userAgent|Firefox|Safari/);
});
