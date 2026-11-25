// The partner backend: the only place that knows the organisation token.
// Browsers talk to this server; this server talks to Kefas.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { createKefasClient, KefasError } from './kefas.js';

const config = {
  port: Number(process.env.PORT ?? 3000),
  kefasUrl: process.env.KEFAS_API_URL ?? 'https://web.kefas.app',
  token: process.env.KEFAS_ORGANISATION_TOKEN,
  channelExternalId: process.env.CHANNEL_EXTERNAL_ID ?? 'kefas-partner-api-example',
};

if (!config.token) {
  console.error('Set KEFAS_ORGANISATION_TOKEN in .env (see .env.example).');
  process.exit(1);
}

const kefas = createKefasClient({ baseUrl: config.kefasUrl, token: config.token });

// The example uses one channel, identified by our own external_id. We keep it in
// memory so a receiver asking for a token does not cost an extra call to Kefas.
let channel = null;

async function loadChannel() {
  if (!channel) {
    const page = await kefas.findChannels({ externalId: config.channelExternalId });
    channel = page[0] ?? null;
  }
  return channel;
}

async function saveChannel({ name, languages }) {
  // Creating with an external_id is idempotent: a second call returns the existing
  // channel (409). Its languages may differ from what we ask now, so update them.
  const existing = await kefas.createChannel({ name, externalId: config.channelExternalId, languages });
  channel = await kefas.updateChannel(existing.id, { name, languages });
  return channel;
}

const routes = {
  // Public: what the receiver page needs to offer a language. No secrets in here.
  'GET /api/channel': async () => (await loadChannel()) ?? { id: null, channel_languages: [] },

  // Operator: in a real app these routes sit behind your own login.
  'POST /api/channel': ({ body }) => saveChannel(body),

  'POST /api/meetings': async ({ body }) => {
    const current = await loadChannel();
    if (!current) throw new HttpError(409, 'Create the channel first.');

    return kefas.createMeeting({
      name: body.name,
      externalId: `example-meeting-${randomUUID()}`, // never reused, one per session
      inputLanguages: [body.input_language],
      channelIds: [current.id],
    });
  },

  'GET /api/meetings/:id': ({ params }) => kefas.getMeeting(params.id),

  // Makes the stream when the speaker starts, or returns the one the meeting already has.
  'POST /api/meetings/:id/stream': ({ params }) => kefas.startStream(params.id),

  'POST /api/meetings/:id/messages': ({ params, body }) =>
    kefas.sendText(params.id, { content: body.content, language: body.language, clientMessageId: randomUUID() }),


  // Receivers: hand out a short-lived token for one channel language.
  // In a real app, check here that the logged-in user may follow this channel,
  // and use your own (non-personal) id for the user as receiver_ref.
  'POST /api/receiver-tokens': async ({ body }) => {
    const current = await loadChannel();
    const allowed = current?.channel_languages.some(cl => cl.id === body.channel_language_id);
    if (!allowed) throw new HttpError(404, 'Unknown channel language.');

    return kefas.createReceiverToken(body.channel_language_id, {
      receiverRef: /^[A-Za-z0-9_-]{1,64}$/.test(body.receiver_ref ?? '') ? body.receiver_ref : undefined,
      ttl: 3600,
    });
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function matchRoute(method, path) {
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(' ');
    if (routeMethod !== method) continue;

    const routeParts = routePath.split('/');
    const pathParts = path.split('/');
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    const matches = routeParts.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(pathParts[i]);
        return true;
      }
      return part === pathParts[i];
    });

    if (matches) return { handler, params };
  }
  return null;
}

const staticFiles = {
  '/vendor/pusher.min.js': 'node_modules/pusher-js/dist/web/pusher.min.js',
};

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

async function serveStatic(path, res) {
  // normalize() on an absolute path drops any '..', so files outside public/ are unreachable.
  const file = staticFiles[path] ?? join('public', normalize(path === '/' ? '/index.html' : path));

  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    sendJson(res, 404, { message: 'Not found.' });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const route = matchRoute(req.method, pathname);

  if (!route) return serveStatic(pathname, res);

  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    sendJson(res, 200, await route.handler({ params: route.params, body }));
  } catch (error) {
    if (error instanceof KefasError) return sendJson(res, error.status, error.body ?? { message: error.message });
    if (error instanceof HttpError) return sendJson(res, error.status, { message: error.message });
    console.error(error);
    sendJson(res, 500, { message: 'Something went wrong.' });
  }
}).listen(config.port, () => {
  console.log(`Example app on http://localhost:${config.port} (Kefas: ${config.kefasUrl})`);
});
