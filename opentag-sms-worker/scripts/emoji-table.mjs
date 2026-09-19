// Regenerates src/slack-emoji.json: Slack emoji shortcode -> emoji string.
// Slack's shortcode names are the iamcal/emoji-data set, which emojibase publishes; the compact
// data supplies the fully-qualified emoji (with the FE0F presentation selector where needed).
// Run: npm run emoji:update
import { writeFile } from 'node:fs/promises';

const BASE = 'https://cdn.jsdelivr.net/npm/emojibase-data@17/en/';
const [shortcodes, compact] = await Promise.all(
	[`${BASE}shortcodes/iamcal.json`, `${BASE}compact.json`].map((url) => fetch(url).then((r) => r.json())),
);

const emojiByHexcode = new Map();
for (const entry of compact) {
	emojiByHexcode.set(entry.hexcode, entry.unicode);
	for (const skin of entry.skins ?? []) emojiByHexcode.set(skin.hexcode, skin.unicode);
}

const table = {};
for (const [hexcode, names] of Object.entries(shortcodes)) {
	for (const name of [names].flat()) table[name] = emojiByHexcode.get(hexcode);
}

await writeFile(new URL('../src/slack-emoji.json', import.meta.url), `${JSON.stringify(table)}\n`);
console.log(`${Object.keys(table).length} shortcodes written to src/slack-emoji.json`);
