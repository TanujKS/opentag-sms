# opentag-sms-worker

Two-way relay between one iMessage group and one Slack channel.

```
iMessage group  ->  Sendblue number in the group  ->  receive webhook   ->  this Worker  ->  chat.postMessage as you (user token)
Slack channel   ->  Slack Events API (OpenTag's messages only)          ->  this Worker  ->  Sendblue send-group-message
```

- Single Cloudflare Worker, one source file: [`src/index.ts`](src/index.ts). Built-in `fetch`, no framework, no storage.
- **iMessage -> Slack**: `POST /webhooks/sendblue/<RELAY_TOKEN>`. Every participant's text and attachment links, labelled with the sender's name (or number). Posts are made **as the user who installed the app** (a `xoxp-` user token), not as the app: Slack marks app-authored mentions as `bot_message`, and agents such as OpenTag ignore those to avoid bot loops.
- **Slack -> iMessage**: `POST /webhooks/slack/events`, verified with the Slack signing secret. Only messages written by the OpenTag agent in the configured channel are sent into the group. When OpenTag answers in a Slack thread under a relayed iMessage, the iMessage is sent as an **inline reply** to the original message.
- A literal `@opentag` typed in iMessage becomes a real Slack mention of OpenTag, so the agent is actually triggered from the group chat.
- Edits, deletions, reactions, Slack file uploads, and threading of iMessage replies back into Slack threads remain out of scope.

## Configuration

| Setting                   | Where                      | Purpose                                                                                                                                  |
| ------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_TOKEN`             | Worker secret              | Random 32-byte hex token protecting the Sendblue receive URL                                                                             |
| `SLACK_SIGNING_SECRET`    | Worker secret              | Slack app signing secret; every request to `/webhooks/slack/events` must carry a valid `v0=` signature                                    |
| `SLACK_USER_TOKEN`        | Worker secret              | User OAuth Token (`xoxp-...`) with user scopes `chat:write`, `channels:history`, `groups:history`. Posts relayed iMessages, reads thread parents |
| `SENDBLUE_API_KEY_ID`     | Worker secret              | Sendblue API key id, used to send group messages                                                                                         |
| `SENDBLUE_API_SECRET_KEY` | Worker secret              | Sendblue API secret                                                                                                                      |
| `ALLOWED_GROUP_ID`        | Worker var                 | Exact Sendblue `group_id` to mirror and to send into. Unset = discovery mode (nothing forwarded either way)                              |
| `SENDER_NAMES`            | Worker var                 | Optional JSON object mapping E.164 number to a display name; unmapped = number                                                           |
| `SLACK_CHANNEL_ID`        | Worker var                 | Slack channel ID (`C...`). Relayed iMessages are posted here; only OpenTag messages from here go to iMessage. Unset = discovery mode      |
| `OPENTAG_SLACK_USER_ID`   | Worker var                 | OpenTag's Slack **member** ID (`U...`, not the `A...` App ID). Filters Slack events and powers the `@opentag` mention. Unset = discovery   |
| `SENDBLUE_FROM_NUMBER`    | Worker var                 | The Sendblue number that sits in the group, E.164; Sendblue requires it as `from_number`. Unset = discovery                              |

iMessage -> Slack forwarding needs `ALLOWED_GROUP_ID` and `SLACK_CHANNEL_ID`; Slack -> iMessage relaying additionally needs `OPENTAG_SLACK_USER_ID` and `SENDBLUE_FROM_NUMBER`. Until then the Worker only logs identifiers.

### Nothing private lives in the repo

The repo is safe to publish as-is: [`wrangler.jsonc`](wrangler.jsonc) carries no deployment-specific value, only the Worker name, runtime settings, and the *names* of the required secrets.

- **Secrets** are set with `wrangler secret put` and stored encrypted on the Worker. Locally they come from `.dev.vars`, which is gitignored (`.dev.vars*` and `.env*`; only `.dev.vars.example` is tracked).
- **The five IDs** (group id, phone numbers, channel and member IDs) are plain vars that are also stored **on the Worker**, set once with `wrangler deploy --var ...` or in the dashboard (step 5 below). `"keep_vars": true` in `wrangler.jsonc` tells wrangler to leave them alone on every later deploy; without it, a deploy replaces the Worker's vars with the ones in the config file, i.e. deletes them. Because they are not in the config, `wrangler types` does not know them either; their types are declared by hand as `RelayEnv` in [`src/index.ts`](src/index.ts).

Before the first push, `git grep -n -e sb_group_ -e xoxp- -e '+1[0-9]\{10\}'` over the staged tree should only hit placeholders (`555` numbers, `xoxp-test`, `xoxp-replace-me`).

## Behavior

### `POST /webhooks/sendblue/<RELAY_TOKEN>` (iMessage -> Slack)

| Incoming request                                             | Result                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Path outside both routes, or non-POST                        | 404 / 405                                                                                 |
| Missing or wrong token                                       | 401, log `{"event":"auth_failed"}`                                                        |
| Body is not a JSON object                                    | 400, log `{"event":"bad_json"}`                                                           |
| `is_outbound: true`                                          | 200, ignored                                                                              |
| `ALLOWED_GROUP_ID` or `SLACK_CHANNEL_ID` empty (discovery)   | 200, log `{"event":"discovery","group_id":...,"message_handle":...,"missing":...}`, nothing forwarded |
| `group_id` differs from `ALLOWED_GROUP_ID` (DM, other group) | 200, ignored                                                                              |
| Matching inbound message                                     | `chat.postMessage` into `SLACK_CHANNEL_ID` as the token's user, wait for `{"ok":true}`, then 200 |
| Slack API error (`slack_not_in_channel`, `slack_invalid_auth`, ...), 429, 5xx, timeout (10 s), network failure | 502, log `{"event":"slack_failed","message_handle":...,"category":...}`; Sendblue retries |

Slack message shape:

```
Tanuj: Can we move the meeting to 3?
```

```
Tanuj: look at this
Attachment: <https://cdn.sendblue.../photo.jpg>
```

```
+15555550999: [Unsupported message content]
```

Posts appear under the name and avatar of whoever installed the Slack app (the owner of `SLACK_USER_TOKEN`); the `Sender:` prefix keeps the real author visible. Copied text is escaped (`&`, `<`, `>`) so participants cannot trigger `<!channel>` or `<@user>` mentions; bare URLs still auto-link. Emoji and newlines pass through unchanged. The one deliberate exception: with `OPENTAG_SLACK_USER_ID` set to a `U...` member ID, `@opentag` (any case, as a word; `email@opentag.com` is left alone) becomes `<@U...>` so OpenTag is pinged. Because the post comes from a human account, OpenTag receives a normal `app_mention` and answers; the same mention posted by an app would arrive as `subtype: bot_message` and be ignored.

Each relayed post is also sent as a Block Kit `section` whose `block_id` is `sb:<message_handle>`. Slack stores block ids, which is how a later thread reply is mapped back to the iMessage it answers, without any database. Messages longer than 3000 characters are posted as plain text and cannot be replied to inline.

### `POST /webhooks/slack/events` (Slack -> iMessage)

| Incoming request                                                                         | Result                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Missing, wrong, or stale (> 5 min) `X-Slack-Signature` / `X-Slack-Request-Timestamp`     | 401, log `{"event":"slack_auth_failed"}`                                                         |
| Signed body that is not a JSON object                                                    | 400, log `{"event":"slack_bad_json"}`                                                            |
| `url_verification`                                                                       | 200 `{"challenge": ...}` (Slack's one-time handshake when you save the Request URL)              |
| Not a `message` event; subtype `message_changed`, `message_deleted`, joins, topic, hidden | 200, ignored                                                                                     |
| Any of the four Slack-side vars empty (discovery mode)                                   | 200, log `{"event":"slack_discovery","channel":...,"user":...,"bot_id":...,...}`, nothing relayed |
| Message in another channel                                                               | 200, ignored                                                                                     |
| Message from anyone but OpenTag (humans, this relay's own posts)                         | 200, ignored, log `{"event":"slack_ignored_sender","user":...,"bot_id":...,"app_id":...}` (IDs only) |
| OpenTag message without text (e.g. file only)                                            | 200, log `{"event":"slack_relay_skipped","category":"no_text"}`                                  |
| OpenTag message                                                                          | 200 `Accepted` immediately; delivery continues in the background (see below)                     |

Slack retries any event not acknowledged within 3 seconds, so the Worker acknowledges first and then, via `waitUntil`:

1. If the message is a thread reply (`thread_ts` present and different from `ts`), fetch the thread parent with `conversations.replies` and look for an `sb:` block id. Failures are logged as `thread_lookup_failed` and the message is still delivered, just not as an inline reply.
2. Lay the message out from its `blocks`, which is what Slack renders: each section, header, quote line and list item on its own line (`•` bullets, `1.` numbering, nested lists indented), newlines kept as they are. The event's `text` field is used only when the message has no blocks, because apps send it as a one-line notification fallback (OpenTag's arrives with newlines flattened to spaces and a stray `<br>`).
3. Convert Slack markup to plain text: `<@U1|tanuj>` -> `@tanuj`, `<#C1|general>` -> `#general`, `<!here>` -> `@here`, `<https://x|label>` -> `label (https://x)`, `&amp;` -> `&`, literal `<br>` -> newline, `*bold*` / `_italic_` / `~strike~` / `` `code` `` markers dropped (only when they sit at word edges, so `a * b` and `snake_case` survive), and `:zap:` -> ⚡ via Slack's own shortcode table (`src/slack-emoji.json`). Unknown shortcodes such as custom workspace emoji stay as `:name:`.
4. `POST https://api.sendblue.com/api/send-group-message` with `group_id`, `from_number`, `content`, and `reply_to: {message_handle}` when a parent handle was found. If Sendblue rejects the inline reply (HTTP 4xx, e.g. the line is not V2 or the target is gone), it is resent once as a plain group message (`reply_rejected` log).
5. Log `{"event":"slack_relayed","slack_ts":...,"inline_reply":"true|false","message_handle":...}` or `{"event":"slack_relay_failed","slack_ts":...,"category":...}`.

Logs never contain tokens, secrets, URLs, or message text in either direction.

## Local development

Prerequisites: Node 20+ and npm (this repo was set up with Node 24 / npm 11).

```bash
cd opentag-sms-worker
npm install
cp .dev.vars.example .dev.vars          # then edit .dev.vars
openssl rand -hex 32                     # paste as RELAY_TOKEN in .dev.vars
npm run typecheck
npm test                                 # 74 vitest checks in workerd; Slack and Sendblue are mocked
```

### Smoke check against `wrangler dev`

Terminal 1 (the IDs are not read from `.dev.vars`, so pass them with `--var`; omit them for discovery mode):

```bash
npx wrangler dev \
  --var ALLOWED_GROUP_ID:demo-group --var 'SENDER_NAMES:{"+15555550123":"Tanuj"}' \
  --var SLACK_CHANNEL_ID:C0DEMO --var OPENTAG_SLACK_USER_ID:U0OPENTAG --var SENDBLUE_FROM_NUMBER:+15550000000
```

Terminal 2, iMessage -> Slack:

```bash
TOKEN="$(sed -n 's/^RELAY_TOKEN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' .dev.vars)"
URL="http://localhost:8787/webhooks/sendblue/$TOKEN"
SAMPLE='{"message_handle":"demo-message-001","group_id":"demo-group","is_outbound":false,"status":"RECEIVED","message_type":"message","from_number":"+15555550123","content":"@OpenTag can we move the meeting to 3?","media_url":""}'

# wrong token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d "$SAMPLE" http://localhost:8787/webhooks/sendblue/nope
# malformed JSON -> 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{not json' "$URL"
# matching message -> "Forwarded 200" with a real SLACK_USER_TOKEN and channel (it posts into that channel as you!),
# or 502 + a slack_failed log with category slack_invalid_auth when the token is a placeholder
curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' -d "$SAMPLE" "$URL"
# photo-only and placeholder cases
curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' "$URL" \
  -d '{"message_handle":"demo-message-002","group_id":"demo-group","is_outbound":false,"from_number":"+15555550123","content":"","media_url":"https://example.com/photo.jpg"}'
curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' "$URL" \
  -d '{"message_handle":"demo-message-003","group_id":"demo-group","is_outbound":false,"from_number":"+15555550999","content":"","media_url":""}'
```

Terminal 2, Slack -> iMessage (requests must be signed exactly like Slack does):

```bash
SECRET="$(sed -n 's/^SLACK_SIGNING_SECRET="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' .dev.vars)"
EVENTS="http://localhost:8787/webhooks/slack/events"
slack_post() { # $1 = JSON body
  local ts sig; ts="$(date +%s)"
  sig="v0=$(printf 'v0:%s:%s' "$ts" "$1" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
  curl -s -w ' %{http_code}\n' -X POST "$EVENTS" -H 'content-type: application/json' \
    -H "x-slack-request-timestamp: $ts" -H "x-slack-signature: $sig" -d "$1"
}

# unsigned -> 401
curl -s -w ' %{http_code}\n' -X POST "$EVENTS" -H 'content-type: application/json' -d '{"type":"event_callback"}'
# Slack's handshake -> {"challenge":"abc"} 200
slack_post '{"type":"url_verification","challenge":"abc"}'
# a human's message -> "Ignored: other sender" 200
slack_post '{"type":"event_callback","event":{"type":"message","channel":"C0DEMO","user":"U0HUMAN","ts":"1.1","text":"hi"}}'
# OpenTag, top level -> "Accepted" 200, then a slack_relayed or slack_relay_failed log line in terminal 1
slack_post '{"type":"event_callback","event":{"type":"message","channel":"C0DEMO","user":"U0OPENTAG","ts":"1.2","text":"Got it <@U0HUMAN|tanuj> &amp; all"}}'
# OpenTag, thread reply -> thread lookup (thread_lookup_failed with placeholder token), then delivery attempt
slack_post '{"type":"event_callback","event":{"type":"message","channel":"C0DEMO","user":"U0OPENTAG","ts":"1.3","thread_ts":"1.0","text":"Sure, 3 works"}}'
```

With placeholder Sendblue keys the last two log `slack_relay_failed` with `category":"http_401"`; with real keys and a real `SENDBLUE_FROM_NUMBER`/`ALLOWED_GROUP_ID` they send into the group, so only run them against production values on purpose.

Note: wrangler's own dev access log prints request paths, which include the relay token. That is the local dev server, not the Worker's logging.

## Deployment

### 1. Slack app: scopes, user token, signing secret

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and open the app (or **Create New App** from scratch).
2. **OAuth & Permissions** -> scroll to **Scopes**. There are two lists; both are needed:
   - **User Token Scopes** -> **Add an OAuth Scope** -> `chat:write`, `channels:history`, `groups:history`. These let the Worker post and read threads as you.
   - **Bot Token Scopes** -> `channels:history`, `groups:history`. These are what the Events API needs to deliver channel messages; Slack adds them automatically when you subscribe to the bot events in step 4, so you may find them already present.
3. Scroll to the top of the same page -> **Reinstall to Workspace** -> **Allow** (Slack asks you to confirm the app may act on your behalf). Copy the **User OAuth Token** (`xoxp-...`). Ignore the Bot User OAuth Token; the Worker does not use it.
4. **Basic Information** -> **App Credentials** -> **Show** next to **Signing Secret**, copy it. Not the Verification Token, and not an app-level token (those are `xapp-` tokens for Socket Mode and cannot carry these scopes).
5. Membership: the account whose token you copied must be in the channel (it posts there), and the app's bot must be in the channel too (it receives the events). If the bot is missing, `/invite @<app name>` in the channel.

Event Subscriptions come in step 4, because Slack verifies the Request URL against the deployed Worker.

References: [Events API](https://docs.slack.dev/apis/events-api/), [Verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).

### 2. Sendblue: number, group, API keys, receive webhook

1. Get an iMessage-enabled Sendblue number on a plan with inbound group messaging. Inline replies need a **V2** line. See [Group messages](https://docs.sendblue.com/getting-started/groups/) and [Inline replies](https://docs.sendblue.com/guides/inline-replies/).
2. From Messages on an iPhone/Mac that is in the group, add the Sendblue number as a participant. Note the number in E.164; it becomes `SENDBLUE_FROM_NUMBER`.
3. Dashboard -> **API keys**: copy the key id and secret.
4. Register the Worker URL as a **receive** webhook (dashboard **Developer -> Webhooks**, or the API, which appends and preserves existing registrations):

```bash
curl -X POST https://api.sendblue.com/api/account/webhooks \
  -H "sb-api-key-id: $SENDBLUE_API_KEY_ID" \
  -H "sb-api-secret-key: $SENDBLUE_API_SECRET_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"receive","webhooks":["https://opentag-sms-worker.<your-subdomain>.workers.dev/webhooks/sendblue/<RELAY_TOKEN>"]}'
```

Verify with `GET https://api.sendblue.com/api/account/webhooks` (same headers). Reference: [Webhooks](https://docs.sendblue.com/getting-started/webhooks/).

### 3. Deploy the Worker in discovery mode

```bash
cd opentag-sms-worker
npx wrangler login
openssl rand -hex 32                               # generate the relay token, keep it for the Sendblue webhook URL
npx wrangler secret put RELAY_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET       # step 1.4
npx wrangler secret put SLACK_USER_TOKEN           # step 1.3, xoxp-...
npx wrangler secret put SENDBLUE_API_KEY_ID        # step 2.3
npx wrangler secret put SENDBLUE_API_SECRET_KEY
npm run deploy
```

`wrangler deploy` prints the Worker URL, e.g. `https://opentag-sms-worker.<your-subdomain>.workers.dev`. The two endpoints are:

```
https://opentag-sms-worker.<your-subdomain>.workers.dev/webhooks/sendblue/<RELAY_TOKEN>
https://opentag-sms-worker.<your-subdomain>.workers.dev/webhooks/slack/events
```

The deploy fails if any of the five secrets is missing, because `wrangler.jsonc` declares them under `secrets.required`. If you set `SLACK_WEBHOOK_URL` or `SLACK_BOT_TOKEN` for an earlier version, they are unused now; `npx wrangler secret delete <NAME>` removes them.

### 4. Slack app: Event Subscriptions

1. **Socket Mode** (left nav, under Settings) -> **Enable Socket Mode** must be **off**. With it on, Slack delivers events over a WebSocket to an `xapp-` client and never POSTs to the Request URL, even though the URL still shows **Verified**. The tell is the grey notice under the Request URL field: "Socket Mode is enabled. You won't need to specify a Request URL."
2. **Event Subscriptions** -> toggle **Enable Events** on.
3. **Request URL**: paste `https://opentag-sms-worker.<your-subdomain>.workers.dev/webhooks/slack/events`, exactly that, no trailing slash (the Worker answers 404 to `/events/`). Slack immediately sends a signed `url_verification` and must show **Verified**. If it fails, check that `SLACK_SIGNING_SECRET` matches the app and that the Worker is deployed.
4. **Subscribe to bot events** -> add `message.groups` (private channel) and `message.channels` (public channel). **Save Changes**; the page keeps edits pending until you do.
5. If Slack shows a banner asking to reinstall, do so (**Install App** -> **Reinstall**).
6. Confirm delivery before going further: with `npx wrangler tail --format pretty` running, post anything in the channel yourself. Every message must produce a `POST /webhooks/slack/events` line; once the IDs are set (step 5), your own posts additionally log `slack_ignored_sender`. See [Troubleshooting](#troubleshooting) if nothing arrives.

### 5. Discover the IDs, then lock the relay to them

With the IDs still unset the Worker forwards nothing in either direction and only logs identifiers.

```bash
npx wrangler tail --format pretty
```

- **Group ID**: send a distinctive message in the iMessage group (e.g. `relay-setup-1234`). The tail shows `{"event":"discovery","group_id":"<the real group id>","message_handle":"..."}`.
- **Slack channel and OpenTag IDs**: in the Slack channel, mention OpenTag so it replies (or post anything). Each message logs `{"event":"slack_discovery","channel":"C...","user":"U...","bot_id":"B...","app_id":"A...",...}`. Take `channel` from any line and `user` from OpenTag's own reply. Alternatively: channel details -> **About** -> Channel ID; click OpenTag's name -> profile -> **...** -> **Copy member ID**. Use the `U...` member ID, not the `A...` App ID from the app directory URL: an App ID still filters events correctly, but the `@opentag` mention only works with the member ID.

Set the values **on the Worker**, not in `wrangler.jsonc` (which is committed). One deploy with `--var` does it; every plain `npm run deploy` afterwards keeps them thanks to `keep_vars`:

```bash
npx wrangler deploy \
  --var ALLOWED_GROUP_ID:'<the real group id>' \
  --var 'SENDER_NAMES:{"+14085550100":"Ada","+12245550101":"Grace"}' \
  --var SLACK_CHANNEL_ID:C0123456789 \
  --var OPENTAG_SLACK_USER_ID:U0123456789 \
  --var SENDBLUE_FROM_NUMBER:+14155550199
```

Equivalent: dashboard -> **Workers & Pages** -> `opentag-sms-worker` -> **Settings** -> **Variables and Secrets** -> **Add** (type *Text*, or *JSON* for `SENDER_NAMES`) -> **Deploy**. The dashboard is also the place to read the current values back and to edit one later, e.g. adding a group member to `SENDER_NAMES`; `wrangler deploy --var NAME:value` overwrites just that one var too. Note that only `keep_vars` stands between these values and deletion: never remove it, and do not add a `vars` block with the same names to `wrangler.jsonc`, since config values would win on the next deploy.

`npm run cf-typegen` is only needed when `secrets.required` changes; the IDs are typed by hand in `RelayEnv` (`src/index.ts`).

### 6. Live acceptance test

iMessage -> Slack

- [ ] Text from two different group members appears in Slack, posted from your account, each with the correct `Sender:` label.
- [ ] A photo-only message produces a clickable `Attachment:` link (open it; Sendblue-hosted links may be time-limited).
- [ ] Emoji, multiline text, and URLs survive; a message containing `<!channel>` or `@channel` does not notify anyone.
- [ ] A message containing `@opentag` renders as a real @OpenTag mention in Slack and OpenTag responds.
- [ ] A DM to the Sendblue number, a message in another group, and a message sent from the Sendblue number itself produce no Slack post.
- [ ] `curl` with a wrong token gets 401; malformed JSON gets 400.

Slack -> iMessage

- [ ] OpenTag's thread reply under a relayed iMessage arrives in the group as an inline reply to that exact iMessage (`slack_relayed` with `"inline_reply":"true"`). If the tail shows `reply_rejected`, the Sendblue line does not support inline replies; the message still arrives as a normal message.
- [ ] A top-level OpenTag message in the channel arrives in the group as a normal message.
- [ ] A human's Slack message, and the relay's own posts, do not arrive in the group.
- [ ] Slack markup in OpenTag's message (mentions, links, `&amp;`, `*bold*`, `<br>`, `:zap:`) reads as plain text with real emoji in iMessage.
- [ ] `npx wrangler tail` shows no message text, tokens, or URLs.
- [ ] Temporarily set `SLACK_USER_TOKEN` to an invalid value: the Worker returns 502 and logs `slack_failed` with `slack_invalid_auth`; restore it and confirm delivery returns to 200.

## Troubleshooting

### Slack -> iMessage: OpenTag's message never reaches the group

Read `npx wrangler tail --format pretty` (or the Workers Observability logs) while it happens, and match the pattern:

| What the tail shows                                                                                   | Meaning                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only `POST /webhooks/sendblue/...` lines; no `POST /webhooks/slack/events` when the message is posted | Slack is not delivering events. In order of likelihood: **Socket Mode is on** (step 4.1, this one bit the first deployment: URL verified, zero events); the app's bot is not in the channel (`/invite @<app name>`); `message.groups` missing for a private channel; unsaved changes or a pending reinstall on the Event Subscriptions page. A single Slack request with no log line under it is just the `url_verification` handshake from saving the URL |
| `POST /webhooks/slack/events` then `slack_ignored_sender` for OpenTag's message                        | Events arrive, but OpenTag posts under a different ID than `OPENTAG_SLACK_USER_ID`. Copy `user` (`U...`) from that log and `npx wrangler deploy --var OPENTAG_SLACK_USER_ID:U...`                                             |
| `slack_discovery`                                                                                     | One of `SLACK_CHANNEL_ID`, `OPENTAG_SLACK_USER_ID`, `SENDBLUE_FROM_NUMBER`, `ALLOWED_GROUP_ID` is unset on the Worker; check **Settings -> Variables and Secrets** against step 5                                             |
| `slack_relay_failed` with `category`                                                                  | The Worker did call Sendblue: `http_401` wrong API keys, `http_400`/`http_404` wrong `ALLOWED_GROUP_ID` or `SENDBLUE_FROM_NUMBER`, `http_403` plan without group sending, `timeout`/`network_error` Sendblue unreachable       |
| `slack_relayed` but nothing in Messages                                                               | Sendblue accepted it; check the Sendblue dashboard message log for that `message_handle`                                                                                                                                     |

To test Sendblue sending on its own, bypassing Slack and the Worker (this is the exact call the Worker makes):

```bash
curl -s -X POST https://api.sendblue.com/api/send-group-message \
  -H "sb-api-key-id: $SENDBLUE_API_KEY_ID" \
  -H "sb-api-secret-key: $SENDBLUE_API_SECRET_KEY" \
  -H "content-type: application/json" \
  -d '{"group_id":"<ALLOWED_GROUP_ID>","from_number":"<SENDBLUE_FROM_NUMBER>","content":"relay test from curl"}'
```

A `QUEUED`/`SENT` response with a `message_handle` (and the text showing up in the group, sent by the Sendblue number) proves the keys, group id and number; anything else points at the value named in the error.

## Limitations (accepted for the MVP)

- Best-effort delivery in both directions, no persistent deduplication or replay.
  - iMessage -> Slack: on 502 Sendblue retries up to 3 times, so duplicate posts and out-of-order arrival are possible; prolonged Slack outages can leave gaps.
  - Slack -> iMessage: the Worker acknowledges before delivering (Slack's 3-second rule), so a Sendblue failure is logged (`slack_relay_failed`) but not retried. Slack's own retries, if the Worker ever fails to acknowledge, can produce a duplicate iMessage.
- Relayed iMessages are posted from the account that owns `SLACK_USER_TOKEN`, so Slack (and OpenTag) attribute them to that person; the `Sender:` prefix carries the real author. If that account is deactivated or the token revoked, posting stops (`slack_token_revoked`). A dedicated "iMessage relay" Slack user avoids tying the relay to a real person, at the cost of a seat on paid plans.
- Only OpenTag's messages go to iMessage. Humans in the channel are assumed to also be in the group.
- Files OpenTag attaches in Slack are not relayed (Slack file URLs are private); text-only messages are. A file-only message is skipped.
- Reply mapping is one-directional: OpenTag's thread reply -> iMessage inline reply. An iMessage inline reply to something OpenTag said is posted to Slack as a normal message, not in the thread. Relayed posts longer than 3000 characters carry no block id and cannot be replied to inline.
- Inline replies require a V2 Sendblue line and an iMessage (not SMS) conversation; otherwise Sendblue returns 400 and the message is resent plain.
- iMessage via Sendblue is plain text, so the layout (paragraphs, bullets, numbering, quotes) is reproduced but bold and italic are dropped rather than styled; user mentions without a label appear as `@U...`, and custom workspace emoji stay as `:name:`. The standard emoji table is a snapshot; `npm run emoji:update` refreshes it from emojibase when Slack adds new emoji.
- Media links point at Sendblue-hosted files, not Slack file copies; their lifetime and access rules are Sendblue's.
- Historical messages are not imported.
- One group, one channel, one agent. Change the vars on the Worker (`wrangler deploy --var` or dashboard) to switch.
- The relay token travels in the Sendblue URL, so it is visible wherever request URLs are recorded (Sendblue's webhook configuration, Cloudflare invocation logs). Rotate it by setting a new `RELAY_TOKEN` and re-registering the webhook. The Slack endpoint has no such exposure: it relies on request signing.
- Sendblue group messaging is beta; confirm the callback shape during the live test (the Worker reads `message_handle`, `group_id`, `is_outbound`, `from_number`, `content`, `media_url` and tolerates missing fields).

## Scripts

| Command              | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Local dev server on `http://localhost:8787`               |
| `npm test`           | Run the vitest checks once                                |
| `npm run typecheck`  | Type-check `src/` and `test/`                             |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `secrets.required` |
| `npm run emoji:update` | Regenerate `src/slack-emoji.json` (Slack shortcode -> emoji) from emojibase |
| `npm run deploy`     | Deploy to Cloudflare                                      |
