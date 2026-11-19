// The receiver: follows one channel language. It never sees the organisation
// token; it asks our own backend for a receiver token and talks to Kefas with that.

const channelLanguageId = new URLSearchParams(location.search).get('cl');
const receiverRef = getReceiverRef();

const messages = new Map(); // id -> message, so duplicates and audio updates replace an entry
let credentials = null; // the `data` of the receiver-token response
let pusher = null;
let channel = null;
let refreshTimer = null;
let audioWanted = false;
let audioVoteTimer = null;
const audioQueue = [];
let audioPlaying = false;

const el = id => document.getElementById(id);

if (channelLanguageId) {
  start().catch(showError);
} else {
  showLanguagePicker().catch(showError);
}

async function start() {
  el('receiver').hidden = false;
  const channelInfo = await (await fetch('/api/channel')).json();
  const current = channelInfo.channel_languages.find(cl => cl.id === channelLanguageId);
  el('language').textContent = languageName(current?.language);

  await refreshToken();
  await catchUp();
  connect();
}

// --- Tokens -------------------------------------------------------------------

async function refreshToken() {
  const response = await fetch('/api/receiver-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_language_id: channelLanguageId, receiver_ref: receiverRef }),
  });
  if (!response.ok) throw new Error(`Could not get a receiver token (${response.status}).`);

  const previousChannelName = credentials?.channel_name;
  credentials = await response.json();

  // Renew a minute before the token expires.
  clearTimeout(refreshTimer);
  const msLeft = new Date(credentials.expires_at) - Date.now();
  refreshTimer = setTimeout(() => refreshToken().catch(showError), Math.max(msLeft - 60_000, 30_000));

  // After a rotation the channel name carries a new version: move to it.
  if (pusher && previousChannelName && previousChannelName !== credentials.channel_name) {
    pusher.unsubscribe(previousChannelName);
    subscribe();
  }
}

// Calls the receiver API with the current token; on 401 it gets a fresh token once.
async function receiverApi(method, path, body, retry = true) {
  const response = await fetch(new URL(path, credentials.auth_url), {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credentials.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && retry) {
    await refreshToken();
    return receiverApi(method, path, body, false);
  }
  if (!response.ok) throw new Error(`Kefas answered ${response.status} on ${path}.`);
  return response.json();
}

// --- History and catching up -----------------------------------------------------

async function catchUp() {
  for (;;) {
    const lastId = [...messages.keys()].sort().at(-1);
    const query = lastId ? `?after_id=${lastId}` : '';
    const page = await receiverApi('GET', `/api/receiver/channel-languages/${channelLanguageId}/messages${query}`);
    if (page.data.length === 0) return;
    page.data.forEach(message => addMessage(message, { playAudio: false }));
  }
}

// --- Websocket ----------------------------------------------------------------------

function connect() {
  const { reverb } = credentials;

  pusher = new Pusher(reverb.key, {
    wsHost: reverb.host,
    wsPort: reverb.port,
    wssPort: reverb.port,
    forceTLS: reverb.scheme === 'https',
    enabledTransports: ['ws', 'wss'],
    cluster: 'mt1', // required by pusher-js, ignored by Reverb
    channelAuthorization: { customHandler: authorize },
  });

  let wasConnected = false;
  pusher.connection.bind('state_change', ({ current }) => {
    setStatus(current);
    if (current !== 'connected') return;
    // pusher-js reconnects and re-subscribes by itself; fill the gap once afterwards.
    if (wasConnected) catchUp().catch(showError);
    wasConnected = true;
  });

  subscribe();
}

function subscribe() {
  channel = pusher.subscribe(credentials.channel_name);
  channel.bind('channel-message-sent', message => addMessage(message, { playAudio: true }));
  channel.bind('channel-message-audio-ready', message => addMessage(message, { playAudio: true }));
}

// Pusher asks us to authorise the private channel; Kefas checks the receiver token.
async function authorize({ socketId, channelName }, callback) {
  try {
    const auth = await receiverApi('POST', '/api/receiver/broadcasting/auth', {
      socket_id: socketId,
      channel_name: channelName,
    });
    callback(null, auth);
  } catch (error) {
    callback(error, null);
  }
}

// --- Messages -------------------------------------------------------------------------

function addMessage(message, { playAudio }) {
  const known = messages.get(message.id);
  messages.set(message.id, { ...known, ...message });

  const audioIsNew = message.voice_message_url && !known?.voice_message_url;
  if (playAudio && audioWanted && audioIsNew) enqueueAudio(message.voice_message_url);

  render();
}

function render() {
  const list = el('messages');
  const sorted = [...messages.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

  list.replaceChildren(
    ...sorted.map(message => {
      const item = document.createElement('li');
      const text = document.createElement('p');
      text.textContent = message.text; // never innerHTML: message text is not HTML
      const meta = document.createElement('small');
      meta.textContent = new Date(message.created_at).toLocaleTimeString() + (message.voice_message_url ? ' · 🔊' : '');
      item.append(text, meta);
      return item;
    }),
  );
  el('empty').hidden = sorted.length > 0;
  list.lastElementChild?.scrollIntoView({ block: 'end' });
}

// --- Audio ------------------------------------------------------------------------------

el('audio-toggle').addEventListener('change', async event => {
  audioWanted = event.target.checked;
  clearInterval(audioVoteTimer);
  if (audioWanted) audioVoteTimer = setInterval(() => voteForAudio().catch(showError), 60_000);
  else audioQueue.length = 0;
  await voteForAudio().catch(showError);
});

// A vote lasts about two minutes, so we repeat it every minute while listening.
async function voteForAudio() {
  try {
    const { data } = await receiverApi('POST', `/api/receiver/channel-languages/${channelLanguageId}/audio`, {
      enabled: audioWanted,
    });
    el('audio-status').textContent = data.audio_active ? 'Audio is on for this language.' : '';
  } catch (error) {
    el('audio-status').textContent = 'No audio available for this language.';
    throw error;
  }
}

function enqueueAudio(url) {
  audioQueue.push(url);
  if (!audioPlaying) playNext();
}

function playNext() {
  const url = audioQueue.shift();
  audioPlaying = Boolean(url);
  if (!url) return;

  const player = el('player');
  player.hidden = false;
  player.src = url;
  player.onended = playNext;
  player.onerror = () => {
    el('audio-status').textContent = 'An audio file could not be loaded.';
    console.warn('Could not load audio', url);
    playNext();
  };
  player.play().catch(error => {
    // A load error also rejects play(); onerror already moved on for that one.
    if (error.name !== 'NotAllowedError') return;
    el('audio-status').textContent = 'The browser blocked playback. Untick and tick Listen to allow it.';
    audioQueue.length = 0;
    audioPlaying = false;
  });
}

// --- Helpers ----------------------------------------------------------------------------

async function showLanguagePicker() {
  const response = await fetch('/api/channel');
  const channelInfo = await response.json();
  const list = el('languages');

  list.replaceChildren(
    ...channelInfo.channel_languages.map(cl => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `?cl=${cl.id}`;
      link.textContent = languageName(cl.language);
      item.append(link);
      return item;
    }),
  );
  el('picker').hidden = false;
  el('no-channel').hidden = channelInfo.channel_languages.length > 0;
}

function languageName(code) {
  if (!/^[A-Z]{2}$/i.test(code ?? '')) return '';
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code.toLowerCase());
  } catch {
    return code;
  }
}

function getReceiverRef() {
  // A random id per browser, not personal data. Reusing it counts this browser once.
  let ref = localStorage.getItem('receiver_ref');
  if (!ref) {
    ref = `receiver-${crypto.randomUUID()}`;
    localStorage.setItem('receiver_ref', ref);
  }
  return ref;
}

function setStatus(state) {
  el('status').textContent = state;
  el('status').dataset.state = state;
}

function showError(error) {
  console.error(error);
  el('error').textContent = error.message;
  el('error').hidden = false;
}
