import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
	buildSlackText,
	extractRelayedHandle,
	parseSenderNames,
	slackMarkupToPlainText,
	slackMessagePayload,
	verifySlackSignature,
	type RelayEnv,
} from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TOKEN = 'a'.repeat(64);
const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_REPLIES_URL = 'https://slack.com/api/conversations.replies';
const SENDBLUE_SEND_URL = 'https://api.sendblue.com/api/send-group-message';
const GROUP = 'demo-group';
const CHANNEL = 'C0DEMO';
const OPENTAG = 'U0OPENTAG';
const FROM_NUMBER = '+15550000000';
const SIGNING_SECRET = 'test-signing-secret';
const UNSUPPORTED_PLACEHOLDER = '[Unsupported message content]';

// Tests bring their own configuration; the real IDs live only on the deployed Worker.
const baseEnv: RelayEnv = {
	ALLOWED_GROUP_ID: GROUP,
	SENDER_NAMES: { '+15555550123': 'Tanuj' },
	SLACK_CHANNEL_ID: CHANNEL,
	OPENTAG_SLACK_USER_ID: OPENTAG,
	SENDBLUE_FROM_NUMBER: FROM_NUMBER,
	RELAY_TOKEN: TOKEN,
	SLACK_SIGNING_SECRET: SIGNING_SECRET,
	SLACK_USER_TOKEN: 'xoxp-test',
	SENDBLUE_API_KEY_ID: 'sb-key',
	SENDBLUE_API_SECRET_KEY: 'sb-secret',
};

const samplePayload = {
	message_handle: 'demo-message-001',
	group_id: GROUP,
	is_outbound: false,
	status: 'RECEIVED',
	message_type: 'message',
	from_number: '+15555550123',
	content: 'Can we move the meeting to 3?',
	media_url: '',
};

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	routes = {
		[SLACK_POST_URL]: () => json({ ok: true, channel: CHANNEL, ts: '1700000000.000500' }),
		[SLACK_REPLIES_URL]: () => json({ ok: true, messages: [] }),
		[SENDBLUE_SEND_URL]: () => json({ status: 'QUEUED', message_handle: 'sent-001' }),
	};
	fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
		if (!match) throw new TypeError(`unmocked fetch: ${url}`);
		return routes[match](url, init);
	});
	vi.stubGlobal('fetch', fetchMock);
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

interface RecordedCall {
	url: string;
	init: RequestInit | undefined;
}

function callsTo(prefix: string): RecordedCall[] {
	const calls = fetchMock.mock.calls as Array<[string | URL | Request, RequestInit | undefined]>;
	return calls
		.map(([input, init]): RecordedCall => ({ url: input instanceof Request ? input.url : String(input), init }))
		.filter((call: RecordedCall) => call.url.startsWith(prefix));
}

function bodyOf(prefix: string, index = 0): Record<string, unknown> {
	const call = callsTo(prefix)[index];
	expect(call, `expected a request to ${prefix}`).toBeDefined();
	return JSON.parse(call.init!.body as string);
}

const slackBody = (index = 0) =>
	bodyOf(SLACK_POST_URL, index) as { channel: string; text: string; link_names: boolean; blocks?: unknown[] };
const sendblueBody = (index = 0) => bodyOf(SENDBLUE_SEND_URL, index);

function allLogOutput(): string {
	return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
}

function loggedEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, string>> {
	return (spy.mock.calls as unknown[][]).map((call) => JSON.parse(call[0] as string) as Record<string, string>);
}

async function dispatch(request: Request, env: RelayEnv = baseEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function sendSendblue(body: unknown, options: { env?: RelayEnv; token?: string; path?: string; method?: string } = {}) {
	const path = options.path ?? `/webhooks/sendblue/${options.token ?? TOKEN}`;
	const request = new IncomingRequest(`https://relay.example${path}`, {
		method: options.method ?? 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
	return dispatch(request, options.env);
}

async function signSlack(secret: string, timestamp: string, rawBody: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${rawBody}`)));
	return `v0=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function sendSlack(
	body: unknown,
	options: { env?: RelayEnv; secret?: string; timestamp?: string; signature?: string; method?: string } = {},
) {
	const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
	const method = options.method ?? 'POST';
	const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
	const signature = options.signature ?? (await signSlack(options.secret ?? SIGNING_SECRET, timestamp, rawBody));
	const request = new IncomingRequest('https://relay.example/webhooks/slack/events', {
		method,
		headers: {
			'content-type': 'application/json',
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': signature,
		},
		body: method === 'GET' || method === 'HEAD' ? undefined : rawBody,
	});
	return dispatch(request, options.env);
}

function slackEvent(event: Record<string, unknown>) {
	return {
		type: 'event_callback',
		team_id: 'T0DEMO',
		api_app_id: 'A0RELAY',
		event_id: 'Ev0001',
		event_time: 1_700_000_000,
		event: { type: 'message', channel: CHANNEL, user: OPENTAG, ts: '1700000000.000100', text: 'Got it', ...event },
	};
}

// ===========================================================================
// iMessage -> Slack
// ===========================================================================

describe('routing and authentication (Sendblue endpoint)', () => {
	it('returns 404 for paths outside both webhook routes', async () => {
		const response = await sendSendblue(samplePayload, { path: '/' });
		expect(response.status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 405 for non-POST requests on the webhook path', async () => {
		const response = await sendSendblue(samplePayload, { method: 'PUT' });
		expect(response.status).toBe(405);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a missing token', async () => {
		const response = await sendSendblue(samplePayload, { path: '/webhooks/sendblue/' });
		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an incorrect token, including same-length variants', async () => {
		expect((await sendSendblue(samplePayload, { token: 'wrong-token' })).status).toBe(401);
		expect((await sendSendblue(samplePayload, { token: 'b'.repeat(64) })).status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects everything when RELAY_TOKEN is unset', async () => {
		const response = await sendSendblue(samplePayload, { env: { ...baseEnv, RELAY_TOKEN: '' }, token: '' });
		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not leak the relay token or the Slack token into logs', async () => {
		await sendSendblue(samplePayload, { token: 'wrong-token' });
		await sendSendblue(samplePayload);
		const output = allLogOutput();
		expect(output).not.toContain(TOKEN);
		expect(output).not.toContain('wrong-token');
		expect(output).not.toContain('xoxp-test');
	});
});

describe('malformed Sendblue input', () => {
	it('returns 400 for invalid JSON without throwing', async () => {
		const response = await sendSendblue('{not json');
		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 400 for JSON that is not an object', async () => {
		expect((await sendSendblue('[1,2,3]')).status).toBe(400);
		expect((await sendSendblue('"string"')).status).toBe(400);
		expect((await sendSendblue('null')).status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('tolerates an object with unexpected field types', async () => {
		const response = await sendSendblue({ ...samplePayload, content: 42, from_number: null, media_url: { nope: true } });
		expect(response.status).toBe(200);
		expect(slackBody().text).toBe(`Unknown sender: ${UNSUPPORTED_PLACEHOLDER}`);
	});
});

describe('Sendblue discovery mode', () => {
	const discoveryEnv: RelayEnv = { ...baseEnv, ALLOWED_GROUP_ID: '' };

	it('acknowledges, logs only group_id and message_handle, and forwards nothing', async () => {
		const response = await sendSendblue(samplePayload, { env: discoveryEnv });
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();

		expect(loggedEvents(logSpy)).toEqual([
			{ event: 'discovery', group_id: GROUP, message_handle: 'demo-message-001', missing: 'ALLOWED_GROUP_ID' },
		]);
		expect(allLogOutput()).not.toContain(samplePayload.content);
		expect(allLogOutput()).not.toContain(samplePayload.from_number);
	});

	it('never forwards a DM in discovery mode either', async () => {
		const response = await sendSendblue({ ...samplePayload, group_id: '' }, { env: discoveryEnv });
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('also stays in discovery mode without a Slack channel to post into', async () => {
		expect((await sendSendblue(samplePayload, { env: { ...baseEnv, SLACK_CHANNEL_ID: '' } })).status).toBe(200);
		expect((await sendSendblue(samplePayload, { env: { ...baseEnv, SLACK_CHANNEL_ID: '', ALLOWED_GROUP_ID: '' } })).status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(loggedEvents(logSpy).map((entry) => entry.missing)).toEqual(['SLACK_CHANNEL_ID', 'ALLOWED_GROUP_ID,SLACK_CHANNEL_ID']);
	});

	it('treats vars that were never set on the Worker (a fresh deploy) the same as empty ones', async () => {
		const { ALLOWED_GROUP_ID: _group, SLACK_CHANNEL_ID: _channel, SENDER_NAMES: _names, ...freshEnv } = baseEnv;
		const response = await sendSendblue(samplePayload, { env: freshEnv });
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(loggedEvents(logSpy).map((entry) => entry.missing)).toEqual(['ALLOWED_GROUP_ID,SLACK_CHANNEL_ID']);
	});
});

describe('Sendblue filtering', () => {
	it('ignores outbound callbacks with 200', async () => {
		const response = await sendSendblue({ ...samplePayload, is_outbound: true });
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ignores direct messages (empty group_id) with 200', async () => {
		const response = await sendSendblue({ ...samplePayload, group_id: '' });
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ignores another group's messages with 200", async () => {
		const response = await sendSendblue({ ...samplePayload, group_id: 'some-other-group' });
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ignores payloads with no group_id field at all', async () => {
		const { group_id: _omitted, ...withoutGroup } = samplePayload;
		const response = await sendSendblue(withoutGroup);
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('forwarding to Slack', () => {
	it('posts the sample message into the channel as the token user, with the mapped sender name', async () => {
		const response = await sendSendblue(samplePayload);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Forwarded');

		const [call] = callsTo(SLACK_POST_URL);
		expect(callsTo(SLACK_POST_URL)).toHaveLength(1);
		expect(call.url).toBe(SLACK_POST_URL);
		expect(call.init?.method).toBe('POST');
		const headers = new Headers(call.init?.headers);
		expect(headers.get('content-type')).toContain('application/json');
		expect(headers.get('authorization')).toBe('Bearer xoxp-test');
		expect(call.init?.signal).toBeInstanceOf(AbortSignal);
		expect(slackBody().channel).toBe(CHANNEL);
		expect(slackBody().text).toBe('Tanuj: Can we move the meeting to 3?');
		expect(slackBody().link_names).toBe(false);
	});

	it('tags the post with the Sendblue handle in a section block_id', async () => {
		await sendSendblue(samplePayload);
		expect(slackBody().blocks).toEqual([
			{ type: 'section', block_id: 'sb:demo-message-001', text: { type: 'mrkdwn', text: 'Tanuj: Can we move the meeting to 3?' } },
		]);
	});

	it('omits the block when there is no handle or the text is too long for a section', () => {
		expect(slackMessagePayload('hi', '')).toEqual({ text: 'hi', link_names: false });
		expect(slackMessagePayload('x'.repeat(3001), 'h1')).toEqual({ text: 'x'.repeat(3001), link_names: false });
		expect(slackMessagePayload('hi', 'h1').blocks).toHaveLength(1);
	});

	it('labels two different members correctly, falling back to the number', async () => {
		await sendSendblue(samplePayload);
		await sendSendblue({ ...samplePayload, message_handle: 'demo-message-002', from_number: '+15555550999', content: 'Works for me' });
		expect(slackBody(0).text).toBe('Tanuj: Can we move the meeting to 3?');
		expect(slackBody(1).text).toBe('+15555550999: Works for me');
	});

	it('reads sender names from the SENDER_NAMES binding', async () => {
		await sendSendblue(samplePayload, { env: { ...baseEnv, SENDER_NAMES: { '+15555550123': 'Someone Else' } } });
		expect(slackBody(0).text).toBe('Someone Else: Can we move the meeting to 3?');

		await sendSendblue(samplePayload, { env: { ...baseEnv, SENDER_NAMES: {} } });
		expect(slackBody(1).text).toBe('+15555550123: Can we move the meeting to 3?');

		// A "Text" var (`wrangler deploy --var`, dashboard) arrives as a JSON string.
		await sendSendblue(samplePayload, { env: { ...baseEnv, SENDER_NAMES: JSON.stringify({ '+15555550123': 'From String' }) } });
		expect(slackBody(2).text).toBe('From String: Can we move the meeting to 3?');

		// Unset (fresh Worker, discovery just finished) means every sender shows as their number.
		await sendSendblue(samplePayload, { env: { ...baseEnv, SENDER_NAMES: undefined } });
		expect(slackBody(3).text).toBe('+15555550123: Can we move the meeting to 3?');
	});

	it('forwards a photo-only message as a clickable media link', async () => {
		const response = await sendSendblue({ ...samplePayload, content: '', media_url: 'https://cdn.sendblue.example/media/photo-123.jpg' });
		expect(response.status).toBe(200);
		expect(slackBody().text).toBe('Tanuj:\nAttachment: <https://cdn.sendblue.example/media/photo-123.jpg>');
	});

	it('includes both text and the attachment line when both are present', async () => {
		await sendSendblue({ ...samplePayload, content: 'look at this', media_url: 'https://cdn.sendblue.example/media/clip.mov' });
		expect(slackBody().text).toBe('Tanuj: look at this\nAttachment: <https://cdn.sendblue.example/media/clip.mov>');
	});

	it('preserves emoji, multiline text, and bare URLs', async () => {
		const content = 'Party 🎉🎉\nsecond line\nhttps://example.com/path?a=1&b=2';
		await sendSendblue({ ...samplePayload, content });
		expect(slackBody().text).toBe('Tanuj: Party 🎉🎉\nsecond line\nhttps://example.com/path?a=1&amp;b=2');
	});

	it('escapes copied Slack control sequences so mentions cannot fire', async () => {
		await sendSendblue({ ...samplePayload, content: 'hey <!channel> and <@U12345> see <https://evil.example|click me>' });
		const { text, link_names } = slackBody();
		expect(text).toBe('Tanuj: hey &lt;!channel&gt; and &lt;@U12345&gt; see &lt;https://evil.example|click me&gt;');
		expect(text).not.toContain('<!channel>');
		expect(text).not.toContain('<@U12345>');
		expect(link_names).toBe(false);
	});

	it('turns a literal @opentag into a real mention only when OPENTAG_SLACK_USER_ID is set', async () => {
		await sendSendblue({ ...samplePayload, content: '@OpenTag can you summarize? cc @opentag, not email@opentag.com' });
		expect(slackBody(0).text).toBe(`Tanuj: <@${OPENTAG}> can you summarize? cc <@${OPENTAG}>, not email@opentag.com`);

		await sendSendblue({ ...samplePayload, content: '@opentag hi' }, { env: { ...baseEnv, OPENTAG_SLACK_USER_ID: '' } });
		expect(slackBody(1).text).toBe('Tanuj: @opentag hi');

		// A bot ID (B...) cannot be mentioned, so the text is left alone.
		await sendSendblue({ ...samplePayload, content: '@opentag hi' }, { env: { ...baseEnv, OPENTAG_SLACK_USER_ID: 'B0BOT' } });
		expect(slackBody(2).text).toBe('Tanuj: @opentag hi');
	});

	it('posts an explicit placeholder when there is neither text nor usable media', async () => {
		const response = await sendSendblue({ ...samplePayload, content: '', media_url: '' });
		expect(response.status).toBe(200);
		expect(slackBody().text).toBe(`Tanuj: ${UNSUPPORTED_PLACEHOLDER}`);
	});

	it('treats a non-http media_url as unusable', async () => {
		await sendSendblue({ ...samplePayload, content: '', media_url: 'not a url' });
		expect(slackBody(0).text).toBe(`Tanuj: ${UNSUPPORTED_PLACEHOLDER}`);
		await sendSendblue({ ...samplePayload, content: '', media_url: 'javascript:alert(1)' });
		expect(slackBody(1).text).toBe(`Tanuj: ${UNSUPPORTED_PLACEHOLDER}`);
	});
});

describe('Slack chat.postMessage outcome handling', () => {
	it('returns 502 and logs the handle plus category on a Slack 500', async () => {
		routes[SLACK_POST_URL] = () => new Response('server_error', { status: 500 });
		const response = await sendSendblue(samplePayload);
		expect(response.status).toBe(502);

		expect(loggedEvents(errorSpy)).toEqual([{ event: 'slack_failed', message_handle: 'demo-message-001', category: 'http_500' }]);
		expect(allLogOutput()).not.toContain(samplePayload.content);
	});

	it('returns 502 on a Slack rate limit, whether HTTP 429 or {"error":"ratelimited"}', async () => {
		routes[SLACK_POST_URL] = () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[0].category).toBe('rate_limited');

		routes[SLACK_POST_URL] = () => json({ ok: false, error: 'ratelimited' });
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[1].category).toBe('rate_limited');
	});

	it('returns 502 and surfaces the Slack API error name (not_in_channel, invalid_auth, ...)', async () => {
		routes[SLACK_POST_URL] = () => json({ ok: false, error: 'not_in_channel' });
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[0].category).toBe('slack_not_in_channel');

		routes[SLACK_POST_URL] = () => json({ ok: false, error: 'invalid_auth' });
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[1].category).toBe('slack_invalid_auth');

		routes[SLACK_POST_URL] = () => json({ ok: false });
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[2].category).toBe('slack_unknown_error');
	});

	it('returns 502 when the Slack request times out', async () => {
		routes[SLACK_POST_URL] = () => {
			throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
		};
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[0].category).toBe('timeout');
	});

	it('returns 502 on a network error', async () => {
		routes[SLACK_POST_URL] = () => {
			throw new TypeError('Failed to fetch');
		};
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[0].category).toBe('network_error');
	});

	it('returns 502 when Slack answers 200 with a non-JSON body', async () => {
		routes[SLACK_POST_URL] = () => new Response('ok', { status: 200 });
		expect((await sendSendblue(samplePayload)).status).toBe(502);
		expect(loggedEvents(errorSpy)[0].category).toBe('unexpected_body');
	});

	it('returns 200 only after Slack accepts the post', async () => {
		let resolveSlack!: (response: Response) => void;
		routes[SLACK_POST_URL] = () => new Promise<Response>((resolve) => (resolveSlack = resolve));

		let settled = false;
		const pending = sendSendblue(samplePayload).then((response) => {
			settled = true;
			return response;
		});

		await vi.waitFor(() => expect(callsTo(SLACK_POST_URL)).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		resolveSlack(json({ ok: true, ts: '1700000000.000600' }));
		expect((await pending).status).toBe(200);
	});
});

describe('buildSlackText', () => {
	it('uses the supplied name map and escapes the label too', () => {
		expect(buildSlackText({ from_number: '+15555550123', content: 'hi' }, { '+15555550123': 'Tanuj' })).toBe('Tanuj: hi');
		expect(buildSlackText({ from_number: '+15555550123', content: 'hi' }, { '+15555550123': '<Boss>' })).toBe('&lt;Boss&gt;: hi');
		expect(buildSlackText({ from_number: '+15555550123', content: 'hi' }, {})).toBe('+15555550123: hi');
	});

	it('falls back to "Unknown sender" when from_number is absent', () => {
		expect(buildSlackText({ content: 'hi' }, {})).toBe('Unknown sender: hi');
	});

	it('keeps media links intact even when the URL contains link-breaking characters', () => {
		const text = buildSlackText({ from_number: '+1', content: '', media_url: 'https://cdn.example/a|b>c.jpg' }, {});
		expect(text).toBe('+1:\nAttachment: <https://cdn.example/a%7Cb%3Ec.jpg>');
	});
});

describe('parseSenderNames', () => {
	it('accepts a JSON object and a JSON string of the same shape', () => {
		expect(parseSenderNames({ '+1': 'A', '+2': ' B ' })).toEqual({ '+1': 'A', '+2': 'B' });
		expect(parseSenderNames('{"+1":"A"}')).toEqual({ '+1': 'A' });
	});

	it('drops entries whose value is not a non-empty string', () => {
		expect(parseSenderNames({ '+1': 'A', '+2': 42, '+3': '', '+4': null })).toEqual({ '+1': 'A' });
	});

	it('returns an empty map for malformed or non-object values', () => {
		expect(parseSenderNames('{not json')).toEqual({});
		expect(parseSenderNames(undefined)).toEqual({});
		expect(parseSenderNames(null)).toEqual({});
		expect(parseSenderNames(['+1', 'A'])).toEqual({});
		expect(parseSenderNames(7)).toEqual({});
	});
});

// ===========================================================================
// Slack -> iMessage
// ===========================================================================

describe('Slack events: verification', () => {
	it('returns 405 for non-POST requests', async () => {
		expect((await sendSlack(slackEvent({}), { method: 'GET' })).status).toBe(405);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a missing, malformed, or wrong signature', async () => {
		expect((await sendSlack(slackEvent({}), { signature: '' })).status).toBe(401);
		expect((await sendSlack(slackEvent({}), { signature: 'v0=deadbeef' })).status).toBe(401);
		expect((await sendSlack(slackEvent({}), { secret: 'some-other-secret' })).status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(loggedEvents(warnSpy).every((entry) => entry.event === 'slack_auth_failed')).toBe(true);
	});

	it('rejects a valid signature with a stale timestamp (replay protection)', async () => {
		const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
		expect((await sendSlack(slackEvent({}), { timestamp: stale })).status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects everything when SLACK_SIGNING_SECRET is unset', async () => {
		// Signed correctly for the configured secret, but the Worker has none: nothing can verify.
		const response = await sendSlack(slackEvent({}), { env: { ...baseEnv, SLACK_SIGNING_SECRET: '' } });
		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('verifies the documented v0 signature scheme', async () => {
		const ts = String(Math.floor(Date.now() / 1000));
		const body = '{"type":"event_callback"}';
		const good = await signSlack('s3cret', ts, body);
		expect(await verifySlackSignature('s3cret', ts, good, body)).toBe(true);
		expect(await verifySlackSignature('s3cret', ts, good, body + ' ')).toBe(false);
		expect(await verifySlackSignature('s3cret', 'not-a-number', good, body)).toBe(false);
	});

	it('returns 400 for a signed body that is not a JSON object', async () => {
		expect((await sendSlack('{not json')).status).toBe(400);
		expect((await sendSlack('[1]')).status).toBe(400);
	});

	it('answers the url_verification handshake with the challenge', async () => {
		const response = await sendSlack({ type: 'url_verification', token: 'x', challenge: 'chal-123' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ challenge: 'chal-123' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not leak the signing secret, Slack token, or message text into logs', async () => {
		await sendSlack(slackEvent({ text: 'super secret agent reply' }));
		await sendSlack(slackEvent({}), { secret: 'wrong' });
		const output = allLogOutput();
		expect(output).not.toContain(SIGNING_SECRET);
		expect(output).not.toContain('xoxp-test');
		expect(output).not.toContain('super secret agent reply');
	});
});

describe('Slack events: discovery mode', () => {
	it.each([
		['SLACK_CHANNEL_ID empty', { SLACK_CHANNEL_ID: '' }],
		['OPENTAG_SLACK_USER_ID empty', { OPENTAG_SLACK_USER_ID: '' }],
		['SENDBLUE_FROM_NUMBER empty', { SENDBLUE_FROM_NUMBER: '' }],
		['ALLOWED_GROUP_ID empty', { ALLOWED_GROUP_ID: '' }],
		['SENDBLUE_FROM_NUMBER never set', { SENDBLUE_FROM_NUMBER: undefined }],
	])('with %s it logs identifiers and relays nothing', async (_name, overrides) => {
		const response = await sendSlack(slackEvent({ bot_id: 'B0AGENT', app_id: 'A0AGENT', thread_ts: '1700000000.000001' }), {
			env: { ...baseEnv, ...overrides },
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Discovery mode: not relayed');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(loggedEvents(logSpy)).toEqual([
			{
				event: 'slack_discovery',
				channel: CHANNEL,
				user: OPENTAG,
				bot_id: 'B0AGENT',
				app_id: 'A0AGENT',
				subtype: '',
				ts: '1700000000.000100',
				thread_ts: '1700000000.000001',
			},
		]);
		expect(allLogOutput()).not.toContain('Got it');
	});
});

describe('Slack events: filtering', () => {
	it('ignores non-message events and non-event callbacks', async () => {
		expect((await sendSlack({ type: 'event_callback', event: { type: 'reaction_added', channel: CHANNEL, user: OPENTAG } })).status).toBe(200);
		expect((await sendSlack({ type: 'app_rate_limited' })).status).toBe(200);
		expect((await sendSlack({ type: 'event_callback' })).status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ignores messages from other channels', async () => {
		expect((await sendSlack(slackEvent({ channel: 'C0OTHER' }))).status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ignores messages from anyone other than OpenTag, including the relay itself, logging only their IDs', async () => {
		expect((await sendSlack(slackEvent({ user: 'U0HUMAN', text: 'private words' }))).status).toBe(200);
		expect((await sendSlack(slackEvent({ user: undefined, bot_id: 'B0RELAY', subtype: 'bot_message' }))).status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(loggedEvents(logSpy).map((entry) => [entry.event, entry.user, entry.bot_id])).toEqual([
			['slack_ignored_sender', 'U0HUMAN', ''],
			['slack_ignored_sender', '', 'B0RELAY'],
		]);
		expect(allLogOutput()).not.toContain('private words');
	});

	it('accepts OpenTag identified by bot_id or app_id when configured that way', async () => {
		await sendSlack(slackEvent({ user: undefined, bot_id: 'B0AGENT', subtype: 'bot_message' }), { env: { ...baseEnv, OPENTAG_SLACK_USER_ID: 'B0AGENT' } });
		expect(callsTo(SENDBLUE_SEND_URL)).toHaveLength(1);

		await sendSlack(slackEvent({ user: 'U0AGENT', bot_id: 'B0AGENT', app_id: 'A0AGENT' }), { env: { ...baseEnv, OPENTAG_SLACK_USER_ID: 'A0AGENT' } });
		expect(callsTo(SENDBLUE_SEND_URL)).toHaveLength(2);

		// ...but only a member ID makes the @opentag mention work on the way in.
		await sendSendblue({ ...samplePayload, content: '@opentag hi' }, { env: { ...baseEnv, OPENTAG_SLACK_USER_ID: 'A0AGENT' } });
		expect(slackBody().text).toBe('Tanuj: @opentag hi');
	});

	it('ignores edits, deletions, joins, and hidden messages', async () => {
		for (const subtype of ['message_changed', 'message_deleted', 'channel_join', 'channel_topic']) {
			expect((await sendSlack(slackEvent({ subtype }))).status).toBe(200);
		}
		expect((await sendSlack(slackEvent({ hidden: true }))).status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('skips messages without any text', async () => {
		const response = await sendSlack(slackEvent({ text: '   ' }));
		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(loggedEvents(logSpy)).toEqual([{ event: 'slack_relay_skipped', slack_ts: '1700000000.000100', category: 'no_text' }]);
	});
});

describe('Slack events: relaying into the group', () => {
	it('acknowledges immediately and sends a plain group message for a top-level post', async () => {
		const response = await sendSlack(slackEvent({ text: 'Got it — those messages are coming through from SMS okay' }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Accepted');

		expect(callsTo(SLACK_REPLIES_URL)).toHaveLength(0);
		const [call] = callsTo(SENDBLUE_SEND_URL);
		expect(call.init?.method).toBe('POST');
		const headers = new Headers(call.init?.headers);
		expect(headers.get('sb-api-key-id')).toBe('sb-key');
		expect(headers.get('sb-api-secret-key')).toBe('sb-secret');
		expect(sendblueBody()).toEqual({
			group_id: GROUP,
			from_number: FROM_NUMBER,
			content: 'Got it — those messages are coming through from SMS okay',
		});
		expect(loggedEvents(logSpy)).toEqual([
			{ event: 'slack_relayed', slack_ts: '1700000000.000100', inline_reply: 'false', message_handle: 'sent-001' },
		]);
	});

	it('does not wait for Sendblue before acknowledging Slack', async () => {
		let resolveSendblue!: (response: Response) => void;
		routes[SENDBLUE_SEND_URL] = () => new Promise<Response>((resolve) => (resolveSendblue = resolve));

		const request = new IncomingRequest('https://relay.example/webhooks/slack/events', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
				'x-slack-signature': await signSlack(SIGNING_SECRET, String(Math.floor(Date.now() / 1000)), JSON.stringify(slackEvent({}))),
			},
			body: JSON.stringify(slackEvent({})),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, baseEnv, ctx);
		expect(response.status).toBe(200);

		await vi.waitFor(() => expect(callsTo(SENDBLUE_SEND_URL)).toHaveLength(1));
		resolveSendblue(json({ status: 'QUEUED', message_handle: 'sent-late' }));
		await waitOnExecutionContext(ctx);
		expect(loggedEvents(logSpy)[0].message_handle).toBe('sent-late');
	});

	it('converts Slack markup to plain text before sending', async () => {
		await sendSlack(slackEvent({ text: 'Hi <@U0HUMAN|tanuj>, see <https://example.com/doc|the doc> &amp; <#C0DEMO|founders> <!here>' }));
		expect(sendblueBody().content).toBe('Hi @tanuj, see the doc (https://example.com/doc) & #founders @here');
	});

	it('falls back to rich_text blocks when text is empty', async () => {
		await sendSlack(
			slackEvent({
				text: '',
				blocks: [
					{
						type: 'rich_text',
						block_id: 'x',
						elements: [
							{
								type: 'rich_text_section',
								elements: [
									{ type: 'text', text: 'Summary ' },
									{ type: 'emoji', name: 'tada' },
									{ type: 'text', text: ' for ' },
									{ type: 'user', user_id: 'U0HUMAN' },
								],
							},
							{
								type: 'rich_text_list',
								style: 'bullet',
								elements: [
									{ type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] },
									{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com', text: 'two' }] },
								],
							},
						],
					},
				],
			}),
		);
		expect(sendblueBody().content).toBe('Summary :tada: for @U0HUMAN\n- one\n- two');
	});

	it('sends a thread reply as an iMessage inline reply when the parent is a relayed iMessage', async () => {
		routes[SLACK_REPLIES_URL] = (url) => {
			const params = new URL(url).searchParams;
			expect(params.get('channel')).toBe(CHANNEL);
			expect(params.get('ts')).toBe('1700000000.000001');
			return json({
				ok: true,
				messages: [
					{
						type: 'message',
						ts: '1700000000.000001',
						text: 'Tanuj: Can we move the meeting to 3?',
						blocks: [{ type: 'section', block_id: 'sb:demo-message-001', text: { type: 'mrkdwn', text: 'Tanuj: Can we move the meeting to 3?' } }],
					},
				],
			});
		};

		await sendSlack(slackEvent({ text: 'Sure, 3 works', thread_ts: '1700000000.000001' }));

		const [lookup] = callsTo(SLACK_REPLIES_URL);
		expect(new Headers(lookup.init?.headers).get('authorization')).toBe('Bearer xoxp-test');
		expect(sendblueBody()).toEqual({
			group_id: GROUP,
			from_number: FROM_NUMBER,
			content: 'Sure, 3 works',
			reply_to: { message_handle: 'demo-message-001' },
		});
		expect(loggedEvents(logSpy)[0].inline_reply).toBe('true');
	});

	it('sends a plain message when the thread parent is not a relayed iMessage', async () => {
		routes[SLACK_REPLIES_URL] = () =>
			json({ ok: true, messages: [{ type: 'message', ts: '1700000000.000001', user: 'U0HUMAN', text: '@OpenTag hey', blocks: [{ type: 'rich_text', block_id: 'abc' }] }] });
		await sendSlack(slackEvent({ text: 'Got it', thread_ts: '1700000000.000001' }));
		expect(sendblueBody()).not.toHaveProperty('reply_to');
	});

	it('does not look up the thread for a thread parent itself (thread_ts equals ts)', async () => {
		await sendSlack(slackEvent({ thread_ts: '1700000000.000100' }));
		expect(callsTo(SLACK_REPLIES_URL)).toHaveLength(0);
		expect(sendblueBody()).not.toHaveProperty('reply_to');
	});

	it('still delivers when the thread lookup fails', async () => {
		routes[SLACK_REPLIES_URL] = () => json({ ok: false, error: 'missing_scope' });
		await sendSlack(slackEvent({ text: 'Got it', thread_ts: '1700000000.000001' }));
		expect(sendblueBody()).not.toHaveProperty('reply_to');
		expect(loggedEvents(warnSpy)).toEqual([{ event: 'thread_lookup_failed', category: 'missing_scope' }]);

		routes[SLACK_REPLIES_URL] = () => new Response('nope', { status: 500 });
		await sendSlack(slackEvent({ text: 'Got it', thread_ts: '1700000000.000001' }));
		expect(sendblueBody(1)).not.toHaveProperty('reply_to');
		expect(loggedEvents(warnSpy)[1].category).toBe('http_500');
	});

	it('retries as a plain message when Sendblue rejects the inline reply', async () => {
		routes[SLACK_REPLIES_URL] = () =>
			json({ ok: true, messages: [{ ts: '1700000000.000001', blocks: [{ type: 'section', block_id: 'sb:old-handle' }] }] });
		let attempt = 0;
		routes[SENDBLUE_SEND_URL] = () => {
			attempt += 1;
			return attempt === 1 ? json({ status: 'ERROR', error_message: 'reply target invalid' }, 400) : json({ status: 'QUEUED', message_handle: 'sent-plain' });
		};

		await sendSlack(slackEvent({ text: 'Got it', thread_ts: '1700000000.000001' }));

		expect(callsTo(SENDBLUE_SEND_URL)).toHaveLength(2);
		expect(sendblueBody(0).reply_to).toEqual({ message_handle: 'old-handle' });
		expect(sendblueBody(1)).not.toHaveProperty('reply_to');
		expect(loggedEvents(warnSpy)).toEqual([{ event: 'reply_rejected', slack_ts: '1700000000.000100', category: 'http_400' }]);
		expect(loggedEvents(logSpy)).toEqual([
			{ event: 'slack_relayed', slack_ts: '1700000000.000100', inline_reply: 'false', message_handle: 'sent-plain' },
		]);
	});

	it('logs a categorized failure when Sendblue fails, without exposing text or keys', async () => {
		routes[SENDBLUE_SEND_URL] = () => new Response('unauthorized', { status: 401 });
		await sendSlack(slackEvent({ text: 'confidential' }));
		expect(loggedEvents(errorSpy)).toEqual([{ event: 'slack_relay_failed', slack_ts: '1700000000.000100', category: 'http_401' }]);

		routes[SENDBLUE_SEND_URL] = () => json({ status: 'ERROR', error_message: 'line offline' });
		await sendSlack(slackEvent({}));
		expect(loggedEvents(errorSpy)[1].category).toBe('sendblue_error');

		routes[SENDBLUE_SEND_URL] = () => {
			throw new DOMException('timeout', 'TimeoutError');
		};
		await sendSlack(slackEvent({}));
		expect(loggedEvents(errorSpy)[2].category).toBe('timeout');

		routes[SENDBLUE_SEND_URL] = () => new Response('slow down', { status: 429 });
		await sendSlack(slackEvent({}));
		expect(loggedEvents(errorSpy)[3].category).toBe('rate_limited');

		const output = allLogOutput();
		expect(output).not.toContain('confidential');
		expect(output).not.toContain('sb-secret');
	});
});

describe('slackMarkupToPlainText', () => {
	it('handles users, channels, broadcasts, subteams, dates, links, and entities', () => {
		expect(slackMarkupToPlainText('<@U1> <@U2|bob> <#C1> <#C2|gen> <!channel> <!here|@here> <!everyone>')).toBe('@U1 @bob #C1 #gen @channel @here @everyone');
		expect(slackMarkupToPlainText('<!subteam^S1|@eng> <!subteam^S2>')).toBe('@eng @group');
		expect(slackMarkupToPlainText('<!date^1700000000^{date}|Nov 14> x')).toBe('Nov 14 x');
		expect(slackMarkupToPlainText('<https://a.example> <https://b.example|B> <https://c.example|https://c.example>')).toBe(
			'https://a.example B (https://b.example) https://c.example',
		);
		expect(slackMarkupToPlainText('<mailto:a@b.co|a@b.co> <tel:+15551234567>')).toBe('a@b.co +15551234567');
		expect(slackMarkupToPlainText('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d');
	});

	it('leaves ordinary text and emoji untouched', () => {
		expect(slackMarkupToPlainText('plain *bold* 🎉 line\nnext')).toBe('plain *bold* 🎉 line\nnext');
	});
});

describe('extractRelayedHandle', () => {
	it('finds the sb: block_id and ignores everything else', () => {
		expect(extractRelayedHandle({ blocks: [{ type: 'rich_text', block_id: 'abc' }, { type: 'section', block_id: 'sb:h-1' }] })).toBe('h-1');
		expect(extractRelayedHandle({ blocks: [{ type: 'section', block_id: 'sb:' }] })).toBeNull();
		expect(extractRelayedHandle({ blocks: [] })).toBeNull();
		expect(extractRelayedHandle({ text: 'no blocks' })).toBeNull();
		expect(extractRelayedHandle(null)).toBeNull();
	});
});
