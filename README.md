# Kefas partner API example

A small, readable app that shows how to integrate the [Kefas partner API](https://web.kefas.app): create a channel with languages, run a meeting, speak or type into it, and let receivers follow the translations live, with audio.

It is an example to read and copy from, not a product. The whole thing is about 800 lines of plain JavaScript: a Node server without a framework and two HTML pages without a build step.

```
 browser (operator page) ──► this server ──(organisation token)──► Kefas partner API
        │                        │
        │ WHIP (microphone)      │ receiver token
        ▼                        ▼
 stream.kefas.app         browser (receiver page) ──(receiver token)──► Kefas receiver API + Reverb
```

The rule the example is built around: **the organisation token never leaves the server.** Browsers only get a receiver token (for one channel language, for one hour) or the WHIP details of one meeting.

## Run it

You need Node 22 or newer and an organisation token with the `partner-api` feature flag (Kefas staff set this up).

```bash
npm install
cp .env.example .env    # then fill in KEFAS_ORGANISATION_TOKEN
npm start
```

Open <http://localhost:3000>:

1. **Channel.** Pick a name and languages (`EN, NL, DE`) and save. The links that appear open a receiver page per language; open one or more in other tabs.
2. **Meeting.** Start a meeting with the language the speaker will use.
3. **Type** a sentence and send it. Every receiver page shows the translation within a few seconds. Tick *Listen* on a receiver page to hear it too.
4. **Speak.** *Start microphone* publishes your microphone over WHIP, and Kefas translates what you say.
5. **End meeting** when you are done. A meeting cannot be restarted; start a new one for the next session.

`/receiver.html` without a `?cl=` parameter shows a language picker.

### Against a preview environment

Set `KEFAS_API_URL` to the preview host, for example `https://pr-825.kefas.dev`. The receiver token response tells the browser which Reverb host to use, so nothing else changes. Audio streaming (WHIP) does not work on preview environments: use *Type* there.

## What is where

| File | What it shows |
| --- | --- |
| [`kefas.js`](kefas.js) | A thin client for the partner API. Note how a `409` on create is treated as success: with an `external_id` the call is idempotent. |
| [`server.js`](server.js) | The partner backend. It keeps the token, creates the channel (by `external_id`) and meetings (a fresh `external_id` per session), relays text, ends meetings, and hands out receiver tokens only for languages of its own channel. |
| [`public/operator.js`](public/operator.js) | The operator and speaker UI: polls the meeting state every 5 seconds, publishes the microphone over WHIP, sends text. |
| [`public/receiver.js`](public/receiver.js) | The receiver: loads the history, subscribes to the private channel with pusher-js, catches up after a reconnect, renews its token before it expires (and on a `401`), follows a token rotation to the new channel name, and asks for audio every minute while *Listen* is on. |

## Before you take this to production

The example leaves out what every real app has, so the API calls stay easy to see:

- **Log in your operators.** Every route except `GET /api/channel` and `POST /api/receiver-tokens` should sit behind your own authentication.
- **Decide who may receive.** `POST /api/receiver-tokens` hands a token to anyone who asks for a language of the example channel. In your app, check that the user may follow that channel, and pass your own non-personal id for the user as `receiver_ref`.
- **Store ids.** Keep the Kefas `id` next to your own `external_id` for channels and meetings in your database, instead of looking the channel up after a restart.
- **Handle `stream_lost`** in the speaker UI: show that the audio stopped and reconnect over WHIP (same URL and token) for up to 10 minutes.

## Can I do this without a backend?

Not completely. Creating channels, meetings, text messages and receiver tokens needs the organisation token, and that token is a secret: CORS on `/api/partner/*` only allows Kefas origins, so a browser cannot call it. What does run in the browser without help: publishing over WHIP and everything a receiver does with its token.

So the minimum is a very small backend that owns the token, such as a single serverless function. `server.js` is that function plus a static file server.
