const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createAuth, signPayload, verifyPayload } = require('../auth');
const { createApp } = require('../server');

const testApps = new Map();
let testAppId = 0;

function fetch(input, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    const app = testApps.get(url.host);
    if (!app) return reject(new Error(`No test application is registered for ${url.host}.`));
    const request = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    request.url = `${url.pathname}${url.search}`;
    request.method = options.method || 'GET';
    request.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    let status = 200;
    let responseHeaders = {};
    const response = {
      writableEnded: false,
      destroyed: false,
      writeHead(responseStatus, headers = {}) {
        status = responseStatus;
        responseHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
      },
      end(value = '') {
        this.writableEnded = true;
        const body = value ? Buffer.from(value).toString('utf8') : '';
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: {
            get: (name) => {
              const header = responseHeaders[name.toLowerCase()];
              return Array.isArray(header) ? header.join(', ') : header ?? null;
            },
            getSetCookie: () => {
              const header = responseHeaders['set-cookie'];
              return Array.isArray(header) ? header : header ? [header] : [];
            }
          },
          text: async () => body,
          json: async () => JSON.parse(body)
        });
      }
    };
    Promise.resolve(app(request, response)).catch(reject);
  });
}

const AUTH_CONFIG = {
  required: true,
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:4173/auth/entra/callback',
  postLogoutRedirectUri: 'http://localhost:4173/',
  sessionSecret: 'test-session-secret-that-is-long-enough',
  secure: false
};

function cookieValue(response, name) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')];
  const item = values.find((value) => value?.startsWith(`${name}=`));
  return item?.split(';', 1)[0];
}

async function startTestApp(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novella-auth-'));
  const app = createApp({
    dataDir: directory,
    dataFile: path.join(directory, 'project.json'),
    authConfig: AUTH_CONFIG,
    ...options
  });
  const host = `novella-test-${++testAppId}.local`;
  testApps.set(host, app);
  return { server: { close: () => testApps.delete(host) }, base: `http://${host}` };
}

test('signs session payloads and rejects tampering and expiration', () => {
  const secret = 'a-secure-test-secret-with-enough-length';
  const token = signPayload({ subject: 'entra:tenant:object', exp: 200 }, secret);
  assert.equal(verifyPayload(token, secret, 100_000).subject, 'entra:tenant:object');
  assert.equal(verifyPayload(`${token}x`, secret, 100_000), null);
  assert.equal(verifyPayload(token, secret, 201_000), null);
});

test('requires authentication while leaving health and login routes public', async (t) => {
  const { server, base } = await startTestApp();
  t.after(() => server.close());

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const api = await fetch(`${base}/api/novels`);
  assert.equal(api.status, 401);

  const page = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login');

  const login = await fetch(`${base}/login`);
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /Sign in with Microsoft/);
});

test('completes Entra code flow with PKCE, state, nonce, and stable tid/oid identity', async (t) => {
  let grantRequest;
  const fakeClient = {
    randomPKCECodeVerifier: () => 'verifier',
    calculatePKCECodeChallenge: async () => 'challenge',
    randomState: () => 'state',
    randomNonce: () => 'nonce',
    buildAuthorizationUrl: (_config, parameters) => {
      const url = new URL('https://login.microsoftonline.com/authorize');
      Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
      return url;
    },
    authorizationCodeGrant: async (_config, callbackUrl, checks) => {
      grantRequest = { callbackUrl, checks };
      return {
        claims: () => ({
          tid: AUTH_CONFIG.tenantId,
          oid: '33333333-3333-3333-3333-333333333333',
          sub: 'pairwise-subject',
          name: 'Novella Owner',
          preferred_username: 'owner@example.com'
        })
      };
    },
    buildEndSessionUrl: (_config, parameters) => {
      const url = new URL('https://login.microsoftonline.com/logout');
      Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
      return url;
    }
  };
  const { server, base } = await startTestApp({
    oidcFactory: async () => ({ client: fakeClient, config: {} })
  });
  t.after(() => server.close());

  const started = await fetch(`${base}/auth/entra/login`, { redirect: 'manual' });
  assert.equal(started.status, 303);
  const authorizationUrl = new URL(started.headers.get('location'));
  assert.equal(authorizationUrl.searchParams.get('scope'), 'openid profile email');
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl.searchParams.get('state'), 'state');
  assert.equal(authorizationUrl.searchParams.get('nonce'), 'nonce');

  const transactionCookie = cookieValue(started, 'novella_oidc');
  const callback = await fetch(`${base}/auth/entra/callback?code=code&state=state`, {
    headers: { Cookie: transactionCookie },
    redirect: 'manual'
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/');
  assert.equal(grantRequest.callbackUrl.href, `${AUTH_CONFIG.redirectUri}?code=code&state=state`);
  assert.deepEqual(grantRequest.checks, {
    pkceCodeVerifier: 'verifier',
    expectedState: 'state',
    expectedNonce: 'nonce',
    idTokenExpected: true
  });

  const sessionCookie = cookieValue(callback, 'novella_session');
  const sessionResponse = await fetch(`${base}/api/auth/session`, { headers: { Cookie: sessionCookie } });
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(await sessionResponse.json(), {
    required: true,
    user: { provider: 'entra', name: 'Novella Owner', username: 'owner@example.com' }
  });

  const deniedMutation = await fetch(`${base}/api/novels`, {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Denied' })
  });
  assert.equal(deniedMutation.status, 403);

  const allowedMutation = await fetch(`${base}/api/novels`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie,
      Origin: 'http://localhost:4173',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title: 'Allowed' })
  });
  assert.equal(allowedMutation.status, 201);

  const rejectedLogout = await fetch(`${base}/logout`, {
    method: 'POST',
    headers: {
      Cookie: sessionCookie,
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'same-origin'
    },
    redirect: 'manual'
  });
  assert.equal(rejectedLogout.status, 403);

  const logout = await fetch(`${base}/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Sec-Fetch-Site': 'same-origin' },
    redirect: 'manual'
  });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('location'), /^https:\/\/login\.microsoftonline\.com\/logout\?/);
  assert.equal(cookieValue(logout, 'novella_session'), 'novella_session=');
});

test('refuses incomplete production authentication configuration', () => {
  assert.throws(() => createAuth({
    config: { required: true, sessionSecret: 'long-enough-session-secret-for-testing' }
  }), /ENTRA_/);
});
