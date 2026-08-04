const { createHmac, timingSafeEqual } = require('node:crypto');

const SESSION_COOKIE = 'novella_session';
const TRANSACTION_COOKIE = 'novella_oidc';
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const TRANSACTION_TTL_SECONDS = 10 * 60;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 1) return [];
    return [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
  }));
}

function signPayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyPayload(value, secret, now = Date.now()) {
  if (!value || typeof value !== 'string') return null;
  const separator = value.lastIndexOf('.');
  if (separator < 1) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Number.isFinite(payload?.exp) || payload.exp <= Math.floor(now / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeEqual(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const supplied = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function cookie(name, value, { maxAge, secure }) {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function redirect(response, location, cookies = []) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  response.writeHead(303, headers);
  response.end();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function loginPage({ entraEnabled, error }) {
  const options = [];
  if (entraEnabled) {
    options.push('<a class="button microsoft" href="/auth/entra/login">Sign in with Microsoft</a>');
  }
  const errorMessage = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Sign in · Novella</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; color: #302d29; background: #f3efe8; }
      main { width: min(92vw, 410px); padding: 42px; border: 1px solid #ded6ca; border-radius: 18px; background: #fffdf9; box-shadow: 0 18px 60px rgb(58 48 37 / 10%); }
      .mark { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 12px; color: white; background: #6f5c45; font: 600 24px Georgia, serif; }
      h1 { margin: 22px 0 8px; font: 500 30px Georgia, serif; }
      p { margin: 0 0 26px; color: #716b63; line-height: 1.55; }
      .options { display: grid; gap: 12px; }
      .button { display: block; padding: 13px 16px; border-radius: 9px; color: white; background: #5d5143; text-align: center; text-decoration: none; font-weight: 600; }
      .button:hover { background: #4d4237; }
      .button.secondary { color: #514a43; background: #eee8df; }
      .button.secondary:hover { background: #e3dbd0; }
      .error { margin-bottom: 20px; padding: 11px 13px; border-radius: 8px; color: #7d2929; background: #fbe7e7; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">N</div>
      <h1>Welcome to Novella</h1>
      <p>Sign in to open your private writing workspace.</p>
      ${errorMessage}
      <div class="options">${options.join('\n')}</div>
    </main>
  </body>
</html>`;
}

function loadConfig(overrides = {}) {
  const tenantId = String(overrides.tenantId ?? process.env.ENTRA_TENANT_ID ?? '').toLowerCase();
  const redirectUri = overrides.redirectUri ?? process.env.ENTRA_REDIRECT_URI ?? '';
  const postLogoutRedirectUri = overrides.postLogoutRedirectUri
    ?? process.env.ENTRA_POST_LOGOUT_REDIRECT_URI
    ?? '';
  const required = parseBoolean(overrides.required ?? process.env.AUTH_REQUIRED, false);
  const secure = overrides.secure ?? (redirectUri.startsWith('https://') || process.env.NODE_ENV === 'production');
  const sessionTtlSeconds = Number(overrides.sessionTtlSeconds ?? process.env.SESSION_TTL_SECONDS)
    || DEFAULT_SESSION_TTL_SECONDS;

  return {
    required,
    tenantId,
    clientId: overrides.clientId ?? process.env.ENTRA_CLIENT_ID ?? '',
    clientSecret: overrides.clientSecret ?? process.env.ENTRA_CLIENT_SECRET ?? '',
    redirectUri,
    postLogoutRedirectUri,
    sessionSecret: overrides.sessionSecret ?? process.env.SESSION_SECRET ?? '',
    sessionTtlSeconds,
    secure
  };
}

function validateConfig(config) {
  if (!config.required) return;
  if (config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters when authentication is required.');
  }
  const entraValues = [config.tenantId, config.clientId, config.clientSecret, config.redirectUri, config.postLogoutRedirectUri];
  if (entraValues.some((value) => !value)) {
    throw new Error('All ENTRA_* environment variables must be set when authentication is required.');
  }
  const redirect = new URL(config.redirectUri);
  const postLogout = new URL(config.postLogoutRedirectUri);
  if (redirect.pathname !== '/auth/entra/callback') {
    throw new Error('ENTRA_REDIRECT_URI must use the /auth/entra/callback path.');
  }
  if (redirect.origin !== postLogout.origin) {
    throw new Error('Entra redirect and post-logout URIs must use the same origin.');
  }
  if (config.secure && redirect.protocol !== 'https:') {
    throw new Error('Production Entra redirect URIs must use HTTPS.');
  }
}

function createAuth({ config: overrides = {}, oidcFactory } = {}) {
  const config = loadConfig(overrides);
  validateConfig(config);
  const entraEnabled = Boolean(
    config.tenantId && config.clientId && config.clientSecret && config.redirectUri && config.postLogoutRedirectUri
  );
  const publicOrigin = config.redirectUri ? new URL(config.redirectUri).origin : '';
  let oidcPromise;

  async function getOidc() {
    if (!entraEnabled) throw new Error('Microsoft Entra ID is not configured.');
    if (!oidcPromise) oidcPromise = (async () => {
      if (oidcFactory) return oidcFactory(config);
      const client = await import('openid-client');
      const authority = new URL(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/v2.0`);
      const clientConfig = await client.discovery(authority, config.clientId, config.clientSecret);
      return { client, config: clientConfig };
    })();
    return oidcPromise;
  }

  function readSession(request) {
    if (!config.required) return {
      provider: 'local',
      subject: 'local:local-development',
      tenantId: 'local',
      objectId: 'local-development',
      name: 'Local development',
      username: ''
    };
    const value = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const payload = verifyPayload(value, config.sessionSecret);
    if (
      payload?.v !== 1
      || payload.provider !== 'entra'
      || payload.tenantId !== config.tenantId
      || typeof payload.objectId !== 'string'
      || payload.subject !== `entra:${config.tenantId}:${payload.objectId}`
    ) return null;
    return payload;
  }

  function sessionCookie(identity) {
    const now = Math.floor(Date.now() / 1000);
    const value = signPayload({ v: 1, iat: now, exp: now + config.sessionTtlSeconds, ...identity }, config.sessionSecret);
    return cookie(SESSION_COOKIE, value, { maxAge: config.sessionTtlSeconds, secure: config.secure });
  }

  function csrfToken(session) {
    if (!session?.subject || !session?.iat || !session?.exp) return '';
    return createHmac('sha256', config.sessionSecret)
      .update(`novella-csrf:${session.subject}:${session.iat}:${session.exp}`)
      .digest('base64url');
  }

  async function hasValidCsrfToken(request, session) {
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return false;
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) return false;
      chunks.push(chunk);
    }
    const supplied = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('csrfToken');
    return safeEqual(supplied, csrfToken(session));
  }

  function clearCookie(name) {
    return cookie(name, '', { maxAge: 0, secure: config.secure });
  }

  function sendLogin(response, error = '') {
    response.writeHead(error ? 401 : 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(loginPage({ entraEnabled, error }));
  }

  async function startEntra(response) {
    const { client, config: clientConfig } = await getOidc();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const now = Math.floor(Date.now() / 1000);
    const transaction = signPayload({
      v: 1,
      iat: now,
      exp: now + TRANSACTION_TTL_SECONDS,
      codeVerifier,
      state,
      nonce
    }, config.sessionSecret);
    const authorizationUrl = client.buildAuthorizationUrl(clientConfig, {
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce
    });
    redirect(response, authorizationUrl.href, [
      cookie(TRANSACTION_COOKIE, transaction, { maxAge: TRANSACTION_TTL_SECONDS, secure: config.secure })
    ]);
  }

  async function finishEntra(request, response, requestUrl) {
    const transactionValue = parseCookies(request.headers.cookie)[TRANSACTION_COOKIE];
    const transaction = verifyPayload(transactionValue, config.sessionSecret);
    const clearTransaction = clearCookie(TRANSACTION_COOKIE);
    if (transaction?.v !== 1 || !transaction.codeVerifier || !transaction.state || !transaction.nonce) {
      redirect(response, '/login?error=expired', [clearTransaction]);
      return;
    }

    const { client, config: clientConfig } = await getOidc();
    const callbackUrl = new URL(config.redirectUri);
    callbackUrl.search = requestUrl.search;
    const tokens = await client.authorizationCodeGrant(clientConfig, callbackUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true
    });
    const claims = tokens.claims();
    const tenantId = typeof claims?.tid === 'string' ? claims.tid.toLowerCase() : '';
    const objectId = typeof claims?.oid === 'string' ? claims.oid.toLowerCase() : '';
    if (!claims || tenantId !== config.tenantId || !objectId || typeof claims.sub !== 'string') {
      redirect(response, '/login?error=identity', [clearTransaction]);
      return;
    }

    redirect(response, '/', [
      sessionCookie({
        provider: 'entra',
        subject: `entra:${tenantId}:${objectId}`,
        tenantId,
        objectId,
        name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : '',
        username: typeof claims.preferred_username === 'string' ? claims.preferred_username.slice(0, 320) : ''
      }),
      clearTransaction
    ]);
  }

  async function logout(response, session) {
    const cookies = [clearCookie(SESSION_COOKIE), clearCookie(TRANSACTION_COOKIE)];
    if (session?.provider === 'entra' && entraEnabled) {
      const { client, config: clientConfig } = await getOidc();
      const logoutUrl = client.buildEndSessionUrl(clientConfig, {
        post_logout_redirect_uri: config.postLogoutRedirectUri
      });
      redirect(response, logoutUrl.href, cookies);
      return;
    }
    redirect(response, config.postLogoutRedirectUri || '/login', cookies);
  }

  function validMutationOrigin(request) {
    if (!config.required || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
    if (request.headers.origin) return Boolean(publicOrigin && request.headers.origin === publicOrigin);
    return request.headers['sec-fetch-site'] === 'same-origin';
  }

  return {
    config,
    readSession,
    csrfToken,
    validMutationOrigin,
    async handlePublicRoute(request, response, url) {
      if (url.pathname === '/login' && request.method === 'GET') {
        if (readSession(request)) redirect(response, '/');
        else {
          const messages = {
            expired: 'Your sign-in request expired. Please try again.',
            identity: 'Microsoft returned an identity that this application cannot accept.',
            failed: 'Sign-in could not be completed. Please try again.'
          };
          sendLogin(response, messages[url.searchParams.get('error')] || '');
        }
        return true;
      }
      if (url.pathname === '/auth/entra/login' && request.method === 'GET') {
        try {
          await startEntra(response);
        } catch {
          redirect(response, '/login?error=failed');
        }
        return true;
      }
      if (url.pathname === '/auth/entra/callback' && request.method === 'GET') {
        try {
          await finishEntra(request, response, url);
        } catch {
          redirect(response, '/login?error=failed', [clearCookie(TRANSACTION_COOKIE)]);
        }
        return true;
      }
      if (url.pathname === '/logout' && request.method === 'POST') {
        const session = readSession(request);
        if (!validMutationOrigin(request) && !(await hasValidCsrfToken(request, session))) {
          response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ error: 'Request origin is not allowed.' }));
        } else {
          await logout(response, session);
        }
        return true;
      }
      return false;
    }
  };
}

module.exports = {
  createAuth,
  parseCookies,
  signPayload,
  verifyPayload
};
