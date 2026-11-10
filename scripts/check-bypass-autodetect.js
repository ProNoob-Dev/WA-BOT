/**
 * Self-check: auto-bypass of pasted links (no network, no Mongo).
 *
 * 1. extractBypassableUrls pulls every hubcloud/hubdrive link out of a
 *    movie post (the 5-link "OTHER MOMMY" message) in order, deduped.
 * 2. maybeAutoBypass gating: DMs always auto; groups only with /bypasson;
 *    no links / own messages never trigger.
 * 3. Importing AssistService (which now references the bypass extractor)
 *    must not create a module cycle.
 *
 * Run: node scripts/check-bypass-autodetect.js
 */
import assert from 'node:assert/strict';
import BypassController, {
    extractBypassableUrl,
    extractBypassableUrls,
} from '../src/controllers/BypassController.js';
import '../src/services/AssistService.js';

const POST = `*OTHER MOMMY (2026)*
Genre: \`Horror\`
Other.Mommy.2026.2160p.iT.WEB-DL.Hindi.DDP5.1.English.DDP5.1.Atmos.DV.HDR.H.265-4kHdHub.mkv - 16.82 GB
https://hubcloud.pw/drive/cwwasezsnrfy2uw
Other.Mommy.2026.2160p.iT.WEB-DL.Hindi.DDP5.1.English.DDP5.1.Atmos.H.265-4kHdHub.mkv - 8.71 GB
https://hubcloud.pw/drive/0qxmxzzhpi6iqmg
Other.Mommy.2026.1080p.AMZN.WEB-DL.Hindi.DDP5.1.English.DDP5.1.Atmos.H.264-4kHdHub.mkv - 6.6 GB
https://hubcloud.pw/drive/n055xaax5yx51d1
Other.Mommy.2026.1080p.iT.WEB-DL.Hindi.DDP5.1.English.DDP5.1.Atmos.H.265-4kHdHub.mkv - 4.14 GB
https://hubcloud.pw/drive/ztngtmg9otftzd3
Other.Mommy.2026.720p.AMZN.WEB-DL.DUAL.DDP5.1.H.265-KyoGo.mkv [1.75GB]
https://hubcloud.pw/drive/sidgtr3ig6bn60w
_English | Hindi | Esubs_`;

// 1) extraction: all 5 links, in order
const urls = extractBypassableUrls(POST);
assert.deepEqual(urls, [
    'https://hubcloud.pw/drive/cwwasezsnrfy2uw',
    'https://hubcloud.pw/drive/0qxmxzzhpi6iqmg',
    'https://hubcloud.pw/drive/n055xaax5yx51d1',
    'https://hubcloud.pw/drive/ztngtmg9otftzd3',
    'https://hubcloud.pw/drive/sidgtr3ig6bn60w',
]);
assert.equal(extractBypassableUrl(POST), 'https://hubcloud.pw/drive/cwwasezsnrfy2uw');
assert.deepEqual(extractBypassableUrls('no links here'), []);
assert.deepEqual(
    extractBypassableUrls('https://hubcloud.pw/drive/abc https://hubcloud.pw/drive/abc'),
    ['https://hubcloud.pw/drive/abc'],
);

// 2) gating: stub _runBypass, record calls
const calls = [];
const gm = { isBypassAutoEnabled: async (chatId) => chatId === '111@g.us' };
const bc = new BypassController(null, gm);
bc._runBypass = async (sock, chatId, senderJid, got) => { calls.push({ chatId, urls: got }); };

const msg = { key: { fromMe: false }, pushName: 'Tester' };
const DM = '919999999999@s.whatsapp.net';
const GROUP_ON = '111@g.us';
const GROUP_OFF = '222@g.us';

// DM: always auto, even though the group gate would say no
await bc.maybeAutoBypass(null, DM, POST, '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 1);
assert.equal(calls[0].chatId, DM);
assert.equal(calls[0].urls.length, 5);

// Group with /bypasson: auto
await bc.maybeAutoBypass(null, GROUP_ON, POST, '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 2);

// Group without /bypasson: silent
await bc.maybeAutoBypass(null, GROUP_OFF, POST, '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 2);

// No links / own message: silent
await bc.maybeAutoBypass(null, DM, 'hello there', '919999999999@s.whatsapp.net', msg);
await bc.maybeAutoBypass(null, DM, POST, '919999999999@s.whatsapp.net', { key: { fromMe: true } });
assert.equal(calls.length, 2);

console.log('bypass auto-detect (DM + /bypasson groups): ok');

// messageQueue starts a ref'd cleanup interval at import (by design for
// the long-running bot) — a check process must exit explicitly, as the
// other check-*.js scripts do.
process.exit(0);
