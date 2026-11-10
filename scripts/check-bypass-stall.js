/**
 * Self-check: a stuck edit / stuck shortener must not freeze a bypass run.
 *
 * Regression for the live report "slow, gets stuck while creating short
 * links, as we are editing the message": progress edits used to be awaited
 * through the per-chat queue (no timeout), the shortener had no timeout
 * (Mongo can hang ~30s), and the final result edit had no timeout either
 * (a hung edit swallowed the result). Now: progress edits are
 * fire-and-forget, every shorten is bounded (8s, falls back to the direct
 * URL), and the result edit falls back to a fresh message on timeout.
 *
 * Fake socket: message EDITS hang forever, fresh sends resolve instantly.
 * Stubbed shortener: one link's mint hangs forever, the other mints fast.
 * The run must still complete and deliver both links (one direct, one
 * shortened) — and take well under the old unbounded stall.
 *
 * Run: node scripts/check-bypass-stall.js
 */
import assert from 'node:assert/strict';
import BypassController from '../src/controllers/BypassController.js';
import { shortLinkService } from '../src/services/ShortLinkService.js';
import { urlShortener } from '../src/utils/urlShortener.js';

const sent = []; // fresh sends (edits hang, so they never land)
let editAttempts = 0;
const fakeSock = {
    async sendMessage(jid, content) {
        if (content?.edit) {
            editAttempts += 1;
            return new Promise(() => {}); // hung edit — never resolves
        }
        sent.push({ jid, text: content?.text || '' });
        return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
    },
};

const bc = new BypassController(null, null);
bc.isUnlimitedUser = async () => true;
bc.scheduleDelete = () => {};
bc._resolveWithSlot = async () => [{
    title: 'Test',
    links: [
        { label: 'Server A', url: 'https://hubcloud.pw/drive/AAA' },
        { label: 'Server B', url: 'https://hubcloud.pw/drive/BBB' },
    ],
}];

const realShorten = shortLinkService.shorten.bind(shortLinkService);
shortLinkService.shorten = async (url) => {
    if (url.includes('/AAA')) return new Promise(() => {}); // hung Mongo mint
    return { url: 'https://bot.example/d/abc123', code: 'abc123', expiresAt: Date.now() + 3_600_000 };
};
const realDisplay = urlShortener._toDisplayShortUrl.bind(urlShortener);
urlShortener._toDisplayShortUrl = async () => null; // keep the /d/ URL

const msg = { key: { fromMe: false }, pushName: 'Tester' };
const DM = '919999999999@s.whatsapp.net';

const t0 = Date.now();
await bc._runBypass(
    fakeSock,
    DM,
    '919999999999@s.whatsapp.net',
    ['https://hubcloud.pw/drive/AAA', 'https://hubcloud.pw/drive/BBB'],
    msg,
    'Tester',
);
const elapsed = Date.now() - t0;

// The run completed (before the fix it hung forever on the edit/shorten).
assert.ok(elapsed < 30_000, `run took ${elapsed}ms — still unbounded`);
// Progress edits were attempted (and hung), but the run didn't wait on them.
assert.ok(editAttempts >= 1, 'expected at least one edit attempt');
// The result arrived as a fresh message (edit timed out → fallback).
const result = sent[sent.length - 1];
assert.match(result.text, /BYPASS SUCCESSFUL/);
// Hung mint fell back to the direct URL; fast mint kept its /d/ link.
assert.match(result.text, /hubcloud\.pw\/drive\/AAA/);
assert.match(result.text, /bot\.example\/d\/abc123/);
// No progress text arrived after the result (a late edit overwriting it
// would be the clobber this fix prevents). The initial progress message
// itself is the only progress-text send.
assert.equal(sent.filter((s) => s.text.includes('BYPASSING…')).length, 1, 'a late progress edit clobbered the result');
assert.match(sent[sent.length - 1].text, /BYPASS SUCCESSFUL/);

shortLinkService.shorten = realShorten;
urlShortener._toDisplayShortUrl = realDisplay;

console.log(`bypass stall fix: ok (run completed in ${elapsed}ms despite hung edits + hung mint)`);

// messageQueue starts a ref'd cleanup interval at import (by design for
// the long-running bot) — a check process must exit explicitly, as the
// other check-*.js scripts do.
process.exit(0);
