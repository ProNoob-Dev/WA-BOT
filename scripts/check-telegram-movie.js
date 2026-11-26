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
    extractUrlsFromMessage,
    isLimitReply,
    mediaEntries,
    pickOnePerQuality,
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

function fakeClient({ searchMessages = [], botReplies = {} } = {}) {
    // botReplies: { botName: (forwardCount) => [messages] }
    const calls = { forwards: [] };
    let forwardCount = 0;
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
            const fn = botReplies[entity?.__entity];
            return fn ? fn(forwardCount) : searchMessages;
        },
        async forwardMessages(entity, { messages, fromPeer }) {
            forwardCount += 1;
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

const linkReply = (url) => ({
    id: 50, date: 9999999999, message: 'Here is your file, tap below',
    reply_markup: { rows: [{ buttons: [{ url }] }] },
});
const limitReply = { id: 51, date: 9999999999, message: 'Sorry, you have reached the limit of 2 links per minute. Try again later.' };

// 1. Pure helpers -----------------------------------------------------------
assert.deepStrictEqual(
    extractLinks('get it here https://example.com/a and https://example.com/a and http://x.io/b.'),
    ['https://example.com/a', 'http://x.io/b'],
    'extractLinks must dedupe and trim trailing punctuation',
);
assert.deepStrictEqual(extractLinks('no links here'), []);

// Links can hide in a TextUrl entity or an inline button, not just the text.
assert.deepStrictEqual(
    extractUrlsFromMessage({
        message: 'Here is your file',
        entities: [{ className: 'MessageEntityTextUrl', url: 'https://files.example.com/x' }],
    }),
    ['https://files.example.com/x'],
    'TextUrl entity links must be picked up',
);
assert.deepStrictEqual(
    extractUrlsFromMessage({
        message: 'Tap below to download',
        reply_markup: {
            rows: [{ buttons: [
                { className: 'KeyboardButtonUrl', text: 'Download', url: 'https://cdn.example.com/dl/1' },
                { className: 'KeyboardButtonUrl', text: 'Watch', url: 'https://cdn.example.com/watch/1' },
            ] }],
        },
    }),
    ['https://cdn.example.com/dl/1', 'https://cdn.example.com/watch/1'],
    'inline button links must be picked up',
);
assert.deepStrictEqual(
    extractUrlsFromMessage({ message: 'nothing here' }),
    [],
    'a reply with no links anywhere must yield none',
);

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
// Limit detection: a throttling reply counts, a plain "please wait" does not.
assert.strictEqual(isLimitReply('Sorry, you have reached the limit of 2 links per minute'), true);
assert.strictEqual(isLimitReply('You can generate only 2 Links / Min'), true);
assert.strictEqual(isLimitReply('Please wait, generating your link'), false);
assert.strictEqual(isLimitReply('Here is your file'), false);

// One file per quality: the same movie in 720p HDR / 10-bit / HEVC is one file.
const qualityFiles = [
    { fileName: 'Avengers Endgame Encore (2026) 720p HDR.mkv', messageId: 1, documentId: 201 },
    { fileName: 'Avengers Endgame Encore (2026) 720p 10b.mkv', messageId: 2, documentId: 202 },
    { fileName: 'Avengers Endgame Encore (2026) 720p HEV.mkv', messageId: 3, documentId: 203 },
    { fileName: 'Avengers Endgame Encore (2026) 1080p HD.mkv', messageId: 4, documentId: 204 },
    { fileName: 'Avengers Endgame Encore (2026) 480p.mkv', messageId: 5, documentId: 205 },
    { fileName: 'Some Series S01E01 720p.mkv', messageId: 6, documentId: 206 },
    { fileName: 'Some Series S01E02 720p.mkv', messageId: 7, documentId: 207 },
];
const picked = pickOnePerQuality(qualityFiles);
assert.deepStrictEqual(picked.map((f) => f.documentId), [201, 204, 205, 206, 207],
    'one file per quality; episodes keep their own slot');

const searchMsgs = entries.map((e, i) => msg(i + 1, e.documentId, e.caption, e.fileName));
const client = fakeClient({
    searchMessages: searchMsgs,
    botReplies: { reaperfiletolinkbot: () => [linkReply('https://reaper.example.com/dl/abc123')] },
});
const service = new TelegramMovieService({ createClient: () => client });

const found = await service.searchChannel('Hanuman');
assert.strictEqual(found.length, 2, 'searchChannel must return the deduped files');

const result = await service.searchWithLinks('Hanuman');
assert.strictEqual(result.files.length, 2, 'searchWithLinks must return one result per file');
assert.strictEqual(client.calls.forwards.length, 2, 'each file must be forwarded once');
assert.deepStrictEqual(result.files[0].links, ['https://reaper.example.com/dl/abc123']);
assert.deepStrictEqual(result.files[1].links, ['https://reaper.example.com/dl/abc123']);

// Fallback: bot 1 answers the first file, then throttles — the second file
// must go to the next bot, and no link may be sent twice.
const fallbackClient = fakeClient({
    searchMessages: searchMsgs,
    botReplies: {
        reaperfiletolinkbot: (forwards) => (forwards <= 1
            ? [linkReply('https://reaper.example.com/dl/abc123')]
            : [limitReply]),
        PublicDirectFileToLinkBot: () => [linkReply('https://public.example.com/dl/xyz789')],
    },
});
const fallbackService = new TelegramMovieService({ createClient: () => fallbackClient });
const streamed = [];
const fallbackResult = await fallbackService.searchWithLinks('Hanuman', async (entry) => {
    streamed.push(entry);
});
assert.strictEqual(streamed.length, 2, 'onFile must fire once per file, as each finishes');
assert.strictEqual(streamed[0].bot, 'reaperfiletolinkbot');
assert.strictEqual(streamed[1].bot, 'PublicDirectFileToLinkBot', 'throttled bot must fall through to the next one');
assert.deepStrictEqual(streamed[1].links, ['https://public.example.com/dl/xyz789']);
assert.strictEqual(fallbackClient.calls.forwards.length, 3, 'file 1 -> bot 1, file 2 -> bot 1 (limited) -> bot 2');
const allLinks = fallbackResult.files.flatMap((f) => f.links);
assert.strictEqual(new Set(allLinks).size, allLinks.length, 'no link may be sent twice');

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
const allSent = sent.map((s) => s.text).join('\n');
assert.ok(allSent.includes('Hanu-Man.2024.720p.mkv'), 'reply must list the 720p file');
assert.ok(allSent.includes('Hanu-Man.2024.1080p.mkv'), 'reply must list the 1080p file');
assert.ok(allSent.includes('https://reaper.example.com/dl/abc123'), 'reply must include the link bot links');
assert.ok(allSent.includes('Searching Universe Database for *Hanuman*'), 'first message must name Universe Database');
assert.ok(/Sent all links/.test(sent.at(-1)?.text || ''), 'last message must say all links were sent');

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
