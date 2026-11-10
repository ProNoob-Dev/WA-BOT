/**
 * Self-check: channel-link auto-bypass (no network, no Mongo).
 *
 * A whatsapp.com/channel/<code>/<msgId> link pasted in a DM (or a /bypasson
 * group) is resolved to that channel post, and the hubcloud links inside it
 * are bypassed like pasted ones. Uses a fake socket: newsletterMetadata
 * resolves the invite, newsletterFetchMessages returns canned plaintext
 * channel posts (proto-encoded, as the real parser decodes them).
 *
 * Run: node scripts/check-bypass-channellink.js
 */
import assert from 'node:assert/strict';
import { proto } from 'baileys';
import BypassController from '../src/controllers/BypassController.js';
import {
    extractChannelMessageLinks,
    parseChannelMessageLink,
} from '../src/utils/channelResolve.js';

const POST = `*OTHER MOMMY (2026)*
Genre: \`Horror\`
Other.Mommy.2026.2160p.iT.WEB-DL.Hindi.DDP5.1.English.DDP5.1.Atmos.DV.HDR.H.265-4kHdHub.mkv - 16.82 GB
https://hubcloud.pw/drive/cwwasezsnrfy2uw
Other.Mommy.2026.1080p.AMZN.WEB-DL.Hindi.DDP5.1.English.DDP5.1.Atmos.H.264-4kHdHub.mkv - 6.6 GB
https://hubcloud.pw/drive/n055xaax5yx51d1
_English | Hindi | Esubs_`;
const CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb6BxQk72WU0KmCRis41/2289';

// 1) link parsing
assert.deepEqual(parseChannelMessageLink(CHANNEL_URL), {
    code: '0029Vb6BxQk72WU0KmCRis41',
    messageId: '2289',
});
assert.deepEqual(parseChannelMessageLink('https://whatsapp.com/channel/0029Vb6BxQk72WU0KmCRis41'), {
    code: '0029Vb6BxQk72WU0KmCRis41',
    messageId: '',
});
assert.equal(parseChannelMessageLink('https://hubcloud.pw/drive/abc'), null);
assert.deepEqual(
    extractChannelMessageLinks(`check this ${CHANNEL_URL} and ${CHANNEL_URL}`),
    [{ code: '0029Vb6BxQk72WU0KmCRis41', messageId: '2289' }],
);
assert.deepEqual(extractChannelMessageLinks('https://hubcloud.pw/drive/abc'), []);

// 2) fake socket: invite resolves, history returns two canned posts
//    (newest first: 2290 plain text, then 2289 the movie post).
function plaintextNode(id, text) {
    return {
        tag: 'message',
        attrs: { id, t: '1794300000' },
        content: [{
            tag: 'plaintext',
            attrs: {},
            content: proto.Message.encode({ conversation: text }).finish(),
        }],
    };
}
const sent = [];
const fakeSock = {
    async newsletterMetadata(type, code) {
        assert.equal(type, 'invite');
        assert.equal(code, '0029Vb6BxQk72WU0KmCRis41');
        return { id: '123@newsletter', name: 'Test Channel' };
    },
    async newsletterFetchMessages(jid) {
        assert.equal(jid, '123@newsletter');
        return {
            tag: 'iq',
            attrs: {},
            content: [{
                tag: 'message_updates',
                attrs: {},
                content: [
                    plaintextNode('2290', 'Just a hello post, no links here.'),
                    plaintextNode('2289', POST),
                ],
            }],
        };
    },
    async sendMessage(jid, content) {
        sent.push({ jid, text: content?.text || '' });
        return { key: { id: `sent${sent.length}`, remoteJid: jid, fromMe: true } };
    },
};

const calls = [];
const gm = { isBypassAutoEnabled: async (chatId) => chatId === '111@g.us' };
const bc = new BypassController(null, gm);
bc._runBypass = async (sock, chatId, senderJid, got) => { calls.push({ chatId, urls: got }); };

const msg = { key: { fromMe: false }, pushName: 'Tester' };
const DM = '919999999999@s.whatsapp.net';

// 3) DM + channel link to the movie post → its 2 hubcloud links bypass
await bc.maybeAutoBypass(fakeSock, DM, `hey ${CHANNEL_URL}`, '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 1);
assert.deepEqual(calls[0].urls, [
    'https://hubcloud.pw/drive/cwwasezsnrfy2uw',
    'https://hubcloud.pw/drive/n055xaax5yx51d1',
]);

// 4) channel link + a direct link → both bypass, deduped
await bc.maybeAutoBypass(fakeSock, DM, `${CHANNEL_URL} https://hubcloud.pw/drive/cwwasezsnrfy2uw`, '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 2);
assert.deepEqual(calls[1].urls, [
    'https://hubcloud.pw/drive/cwwasezsnrfy2uw',
    'https://hubcloud.pw/drive/n055xaax5yx51d1',
]);

// 5) channel post with no links → no bypass, one "couldn't get links" note
await bc.maybeAutoBypass(fakeSock, DM, 'https://whatsapp.com/channel/0029Vb6BxQk72WU0KmCRis41/2290', '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 2);
assert.equal(sent.length, 1);
assert.match(sent[0].text, /Couldn't get links from that channel message/);

// 6) channel message that doesn't exist → same note, no bypass
await bc.maybeAutoBypass(fakeSock, DM, 'https://whatsapp.com/channel/0029Vb6BxQk72WU0KmCRis41/9999', '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 2);
assert.equal(sent.length, 2);

// 7) group without /bypasson + channel link → silent (gate first, no note)
await bc.maybeAutoBypass(fakeSock, '222@g.us', `hey ${CHANNEL_URL}`, '919999999999@s.whatsapp.net', msg);
assert.equal(calls.length, 2);
assert.equal(sent.length, 2);

console.log('bypass channel-link auto-detect: ok');

// messageQueue starts a ref'd cleanup interval at import (by design for
// the long-running bot) — a check process must exit explicitly, as the
// other check-*.js scripts do.
process.exit(0);
