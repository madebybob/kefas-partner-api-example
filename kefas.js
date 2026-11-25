// A minimal client for the Kefas partner API.
// It runs on your server only: it holds the organisation token.

export class KefasError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Kefas answered ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function createKefasClient({ baseUrl, token }) {
  async function request(method, path, body) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = response.status === 204 ? null : await response.json().catch(() => null);

    // 409 on a create with an existing external_id (or client_message_id) carries
    // the existing record, with the same body as a 201: treat it as a success.
    if (response.ok || (response.status === 409 && json?.data)) {
      return json?.data ?? null;
    }

    throw new KefasError(response.status, json);
  }

  return {
    createChannel: ({ name, externalId, languages }) =>
      request('POST', '/api/partner/channels/create', { name, external_id: externalId, languages }),

    updateChannel: (channelId, changes) =>
      request('POST', `/api/partner/channels/${channelId}/update`, changes),

    findChannels: ({ externalId }) =>
      request('GET', `/api/partner/channels?external_id=${encodeURIComponent(externalId)}`),

    createMeeting: ({ name, externalId, inputLanguages, channelIds }) =>
      request('POST', '/api/partner/meetings/create', {
        name,
        external_id: externalId,
        input_languages: inputLanguages,
        channel_ids: channelIds,
      }),

    getMeeting: meetingId => request('GET', `/api/partner/meetings/${meetingId}`),

    startStream: meetingId => request('POST', `/api/partner/meetings/${meetingId}/stream/start`),

    endMeeting: meetingId => request('POST', `/api/partner/meetings/${meetingId}/end`),

    sendText: (meetingId, { content, language, clientMessageId }) =>
      request('POST', `/api/partner/meetings/${meetingId}/messages/create`, {
        content,
        language,
        client_message_id: clientMessageId,
      }),

    createReceiverToken: (channelLanguageId, { receiverRef, ttl }) =>
      request('POST', `/api/partner/channel-languages/${channelLanguageId}/receiver-tokens/create`, {
        receiver_ref: receiverRef,
        ttl,
      }),
  };
}
