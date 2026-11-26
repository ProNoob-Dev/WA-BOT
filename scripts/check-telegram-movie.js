/**
 * Self-check for the Telegram movie search (/tgmovie, /tglink).
 *
 * 1. Pure helpers: link extraction (deduped, trailing punctuation trimmed),
 *    file entries (video/document only, deduped by Telegram document id —
 *    same file reposted forwards once, different qualities are different
 *    files and all come back).
 * 2. Service with a fake gramJS client (no network): channel search returns
 *    deduped files; each file is forwarded once to the link bot and the
 *    bot's reply links are collected.
 * 3. Login flow with the fake client: beginLogin requests a code,
 *    completeLogin finishes it and returns the account name.
 * 4. /tgmovie, /tm and /tglink are registered (tglink is owner-only) and
 *    wired to handlers; /tgmovie replies with the found files and links.
 *
 * Run: node scripts/check-telegram-movie.js
 */
import assert from 'node:assert';

// config.js reads env at import time, so the test credentials go in first
// and everything below is imported dynamically.
process.env.TG_API_ID = '604512';
process.env.TG_API_HASH = 'test-hash-for-checks';

const {
    TelegramMovieService,
    extractLinks,
    mediaEntries,
} = await import('../src/services/TelegramMovieService.js');
const { findCommand } = await import('../src/commands/registry.js');
const { COMMAND_HANDLERS } = await import('../src/controllers/CommandController.js');
const {
    handleTgMovie,
    handlePendingTelegramInput,
} = await import('../src/controllers/handlers/telegramMovieHandlers.js');

const msg = (id, documentId, caption, fileName) => ({
    id,
    message: caption,
    date: 1764000000,
    media: {
        className: 'MessageMediaDocument',
        document: {
            id: BigInt(documentId),
            size: 12345,
            attributes: [{ className: 'DocumentAttributeFilename', fileName }],
        },
    },
});

function fakeClient({ searchMessages = [], botReplies = [] } = {}) {
    const calls = { forwards: [] };
    return {
        calls,
        async connect() {},
        async disconnect() {},
        async getMe() {
            return { username: 'testuser', firstName: 'Test', id: 1 };
        },
        async getEntity(id) {
            return { __entity: id };
        },
        async getDialogs() {
            return [];
        },
        async getMessages(entity) {
            return entity?.__entity === 'reaperfiletolinkbot' ? botReplies : searchMessages;
        },
        async forwardMessages(entity, { messages, fromPeer }) {
            calls.forwards.push({ entity, messages, fromPeer });
            return [{ id: 999 }];
        },
        async invoke(req) {
            if (req?.className === 'auth.SendCode') {
                return { phoneCodeHash: 'HASH1', type: { className: 'auth.SentCodeTypeApp' } };
            }
            return {};
        },
        session: { save: () => 'FAKE-SESSION' },
    };
}

// 1. Pure helpers -----------------------------------------------------------
assert.deepStrictEqual(
    extractLinks('get it here https://example.com/a and https://example.com/a and http://x.io/b.'),
    ['https://example.com/a', 'http://x.io/b'],
    'extractLinks must dedupe and trim trailing punctuation',
);
assert.deepStrictEqual(extractLinks('no links here'), []);

const entries = mediaEntries([
    msg(1, 111, 'Hanu-Man 2024 720p', 'Hanu-Man.2024.720p.mkv'),
    msg(2, 111, 'Hanu-Man 2024 720p (repost)', 'Hanu-Man.2024.720p.mkv'),
    msg(3, 222, 'Hanu-Man 2024 1080p', 'Hanu-Man.2024.1080p.mkv'),
    { id: 4, message: 'just a text post', date: 1764000000, media: null },
]);
assert.strictEqual(entries.length, 2, 'same document id twice must dedupe to one entry');
assert.deepStrictEqual(
    entries.map((e) => e.documentId),
    ['111', '222'],
    'different qualities are different files and both stay',
);
assert.strictEqual(entries[0].fileName, 'Hanu-Man.2024.720p.mkv');

// 2. Service with a fake client --------------------------------------------
const botReplies = [
    { id: 50, date: 9999999999, message: 'Here is your file: https://reaper.example.com/dl/abc123' },
];
const client = fakeClient({ searchMessages: entries.map((e, i) => msg(i + 1, e.documentId, e.caption, e.fileName)), botReplies });
const service = new TelegramMovieService({ createClient: () => client });

const found = await service.searchChannel('Hanuman');
assert.strictEqual(found.length, 2, 'searchChannel must return the deduped files');

const result = await service.searchWithLinks('Hanuman');
assert.strictEqual(result.files.length, 2, 'searchWithLinks must return one result per file');
assert.strictEqual(client.calls.forwards.length, 2, 'each file must be forwarded once');
assert.deepStrictEqual(result.files[0].links, ['https://reaper.example.com/dl/abc123']);
assert.deepStrictEqual(result.files[1].links, ['https://reaper.example.com/dl/abc123']);

// 3. Login flow --------------------------------------------------------------
const loginClient = fakeClient();
const loginService = new TelegramMovieService({ createClient: () => loginClient });
await loginService.beginLogin('+918830285258', 'chat1', 'owner@lid');
assert.ok(loginService.hasPendingLogin('chat1', 'owner@lid'), 'login must be pending after beginLogin');
assert.ok(!loginService.hasPendingLogin('chat1', 'someone-else@lid'), 'pending login is bound to the requester');
const done = await loginService.completeLogin('12345');
assert.strictEqual(done.username, 'testuser');
assert.strictEqual(done.persisted, false, 'no Koyeb key in tests — session must not be persisted');
assert.ok(loginService.isLoggedIn(), 'service must be logged in after completeLogin');

// 4. Registry + handlers ----------------------------------------------------
assert.strictEqual(findCommand('/tgmovie')?.key, 'tgmovie');
assert.strictEqual(findCommand('/tm')?.key, 'tgmovie');
assert.strictEqual(findCommand('/tglink')?.key, 'tglink');
assert.strictEqual(findCommand('/tglink')?.role, 'owner', '/tglink must be owner-only');
assert.strictEqual(typeof COMMAND_HANDLERS.tgmovie, 'function');
assert.strictEqual(typeof COMMAND_HANDLERS.tglink, 'function');

const sent = [];
const sock = {
    async sendMessage(chatId, content) {
        sent.push({ chatId, text: content.text });
        return { key: { id: 'x' } };
    },
};
await handleTgMovie(sock, 'chat1', 'owner@lid', ['Hanuman'], { telegramMovieService: service });
const reply = sent.at(-1)?.text || '';
assert.ok(reply.includes('Hanu-Man.2024.720p.mkv'), 'reply must list the 720p file');
assert.ok(reply.includes('Hanu-Man.2024.1080p.mkv'), 'reply must list the 1080p file');
assert.ok(reply.includes('https://reaper.example.com/dl/abc123'), 'reply must include the link bot links');

const sent2 = [];
const sock2 = {
    async sendMessage(chatId, content) {
        sent2.push({ chatId, text: content.text });
        return { key: { id: 'x' } };
    },
};
await handleTgMovie(sock2, 'chat1', 'owner@lid', [], { telegramMovieService: service });
assert.ok(/Usage: `\/tgmovie/.test(sent2.at(-1)?.text || ''), 'no query must show usage');

const handled = await handlePendingTelegramInput(
    sock2, 'chat1', 'owner@lid', '12345', { telegramMovieService: loginService },
);
assert.strictEqual(handled, false, 'no pending login on this service — must not consume the message');

console.log('✓ telegram movie search (/tgmovie, /tglink) checks passed');
process.exit(0);
