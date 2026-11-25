// The operator page: sets up the channel, runs a meeting and speaks or types into it.
// It only talks to our own backend, except for WHIP, which goes straight to the stream server.

const el = id => document.getElementById(id);

let meeting = null;
let statePoller = null;
let publisher = null; // { pc, mic } while the microphone is live

loadChannel().catch(showError);
resumeMeeting().catch(showError);

// --- Channel ------------------------------------------------------------------

async function loadChannel() {
  showChannel(await api('GET', '/api/channel'));
}

el('channel-form').addEventListener('submit', async event => {
  event.preventDefault();
  const languages = el('channel-languages').value.split(/[\s,]+/).filter(Boolean);
  const channel = await api('POST', '/api/channel', { name: el('channel-name').value, languages }).catch(showError);
  if (channel) showChannel(channel);
});

function showChannel(channel) {
  if (!channel.id) return;

  el('channel-name').value = channel.name;
  el('channel-languages').value = channel.channel_languages.map(cl => cl.language).join(', ');
  el('meeting-section').hidden = false;

  el('receiver-links').replaceChildren(
    ...channel.channel_languages.map(cl => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/receiver.html?cl=${cl.id}`;
      link.target = '_blank';
      link.textContent = `Receiver page for ${cl.language}`;
      item.append(link);
      return item;
    }),
  );
}

// --- Meeting ------------------------------------------------------------------

el('meeting-form').addEventListener('submit', async event => {
  event.preventDefault();
  const created = await api('POST', '/api/meetings', {
    name: el('meeting-name').value,
    input_language: el('meeting-language').value,
  }).catch(showError);
  if (created) showMeeting(created);
});

async function resumeMeeting() {
  const id = localStorage.getItem('meeting_id');
  if (!id) return;
  const current = await api('GET', `/api/meetings/${id}`).catch(() => null);
  if (current) showMeeting(current);
}

function showMeeting(current) {
  meeting = current;
  localStorage.setItem('meeting_id', meeting.id);
  el('meeting-form').hidden = true;
  el('live').hidden = false;
  el('meeting-title').textContent = meeting.name;
  el('text-language').value = meeting.input_languages[0];
  showState(meeting.state);

  // Poll the state every few seconds, never per receiver.
  clearInterval(statePoller);
  statePoller = setInterval(async () => {
    const latest = await api('GET', `/api/meetings/${meeting.id}`).catch(() => null);
    if (latest) showState(latest.state);
  }, 5000);
}

function showState(state) {
  el('meeting-state').textContent = state;
  el('meeting-state').dataset.state = state;
}

// A meeting has no end in Kefas: stop publishing and forget it here. Kefas stops
// listening once the audio has been gone for 10 minutes.
el('finish-session').addEventListener('click', finishMeeting);

function finishMeeting() {
  clearInterval(statePoller);
  stopMicrophone();
  localStorage.removeItem('meeting_id');
  meeting = null;
  el('live').hidden = true;
  el('meeting-form').hidden = false;
}

// --- Typing text ----------------------------------------------------------------

el('text-form').addEventListener('submit', async event => {
  event.preventDefault();
  const content = el('text-content').value.trim();
  if (!content) return;

  const sent = await api('POST', `/api/meetings/${meeting.id}/messages`, {
    content,
    language: el('text-language').value,
  }).catch(showError);
  if (sent) el('text-content').value = '';
});

// --- Speaking (WHIP) --------------------------------------------------------------

el('mic-toggle').addEventListener('click', async () => {
  if (publisher) return stopMicrophone();

  try {
    // The stream details are a secret for this one meeting. stream/start makes the
    // stream now, or returns the open one, so pressing start again reconnects.
    const { stream } = await api('POST', `/api/meetings/${meeting.id}/stream`);
    publisher = await publish(stream);
    el('mic-toggle').textContent = 'Stop microphone';
  } catch (error) {
    showError(error);
  }
});

async function publish({ whip_url, whip_bearer_token }) {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  mic.getAudioTracks().forEach(track => pc.addTrack(track, mic));

  await pc.setLocalDescription(await pc.createOffer());

  // Wait until ICE gathering is done so the offer contains all candidates.
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve());
  });

  const response = await fetch(whip_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${whip_bearer_token}` },
    body: pc.localDescription.sdp,
  });

  if (!response.ok) {
    pc.close();
    mic.getTracks().forEach(track => track.stop());
    throw new Error(`WHIP failed: ${response.status}${response.status === 429 ? ', wait before retrying' : ''}`);
  }

  await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  return { pc, mic };
}

function stopMicrophone() {
  if (!publisher) return;
  publisher.mic.getTracks().forEach(track => track.stop());
  publisher.pc.close();
  publisher = null;
  el('mic-toggle').textContent = 'Start microphone';
}

// --- Helpers ----------------------------------------------------------------------

async function api(method, path, body) {
  el('error').hidden = true;
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(describeError(json, response.status));
  return json;
}

function describeError(json, status) {
  const firstValidationError = json?.errors && Object.values(json.errors)[0]?.[0];
  return firstValidationError ?? json?.message ?? `Request failed (${status}).`;
}

function showError(error) {
  console.error(error);
  el('error').textContent = error.message;
  el('error').hidden = false;
}
