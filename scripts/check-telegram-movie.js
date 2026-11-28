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
        async getMessages(entity, { limit } = {}) {
            const fn = botReplies[entity?.__entity];
            if (!fn) return searchMessages;
            // The pre-forward baseline read (limit 1) sees only the old
            // message already in the chat; the poll reads the bot's replies.
            if (limit === 1) return [{ id: 10, date: 1, message: 'old message' }];
            return fn(forwardCount);
        },
        async forwardMessages(entity, { messages, fromPeer }) {
            forwardCount += 1;
            calls.forwards.push({ entity, messages, fromPeer });
            return [{ id: 10 }];
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
    botReplies: { cinebox_node1_2gv6_bot: () => [linkReply('https://cinebox.example.com/dl/abc123')] },
});
const service = new TelegramMovieService({ createClient: () => client });

const found = await service.searchChannel('Hanuman');
assert.strictEqual(found.length, 2, 'searchChannel must return the deduped files');

const result = await service.searchWithLinks('Hanuman');
assert.strictEqual(result.files.length, 2, 'searchWithLinks must return one result per file');
assert.strictEqual(client.calls.forwards.length, 2, 'each file must be forwarded once');
assert.deepStrictEqual(result.files[0].links, ['https://cinebox.example.com/dl/abc123']);
assert.deepStrictEqual(result.files[1].links, ['https://cinebox.example.com/dl/abc123']);

// Only the first link per file — a bot that answers with three links
// (download + watch + mirror) sends just the download link on.
const threeLinkClient = fakeClient({
    searchMessages: searchMsgs,
    botReplies: { cinebox_node1_2gv6_bot: () => [{ id: 50, date: 9999999999, message: 'Download https://cinebox.example.com/dl/first Watch https://cinebox.example.com/watch/second Mirror https://cinebox.example.com/dl/third' }] },
});
const threeLinkService = new TelegramMovieService({ createClient: () => threeLinkClient });
const threeLinkResult = await threeLinkService.searchWithLinks('Hanuman');
assert.deepStrictEqual(threeLinkResult.files[0].links, ['https://cinebox.example.com/dl/first'],
    'only the first link per file is kept');

// A reply older than the forward (a previous file's links) is ignored,
// even when it is still among the latest messages.
const staleClient = fakeClient({
    searchMessages: searchMsgs,
    botReplies: { cinebox_node1_2gv6_bot: () => [
        { id: 5, date: 9999999999, message: 'Download https://stale.example.com/old' },
        { id: 50, date: 9999999999, message: 'Download https://cinebox.example.com/dl/fresh' },
    ] },
});
const staleService = new TelegramMovieService({ createClient: () => staleClient });
const staleResult = await staleService.searchWithLinks('Hanuman');
assert.deepStrictEqual(staleResult.files[0].links, ['https://cinebox.example.com/dl/fresh'],
    'an older reply must not stand in for this forward');

// Shortening: a working shortener returns the short link, a failing one
// falls through to the next, and a dead shortener returns the original —
// a link is never lost to the shortener.
const realFetch = globalThis.fetch;
globalThis.fetch = async (endpoint) => ({
    text: async () => (String(endpoint).includes('ulvis') ? 'https://ulvis.net/abc123' : 'https://is.gd/abc123'),
});
assert.strictEqual(
    await service.shortenUrl('https://plgb.koyeb.app/t/dl/AAAAACXF1uBT0TMHAAAeqAA/dn5RMylJhFAZcMyrODSaXL50fgRKjayjS_j4rzWQaUY'),
    'https://ulvis.net/abc123',
);
globalThis.fetch = async (endpoint) => ({
    text: async () => (String(endpoint).includes('ulvis') ? 'Error: Domain not allowed' : 'https://is.gd/abc123'),
});
assert.strictEqual(
    await service.shortenUrl('https://f2l.reaperzclub.dpdns.org/xp169s9?hash=AgADph&dl=1'),
    'https://is.gd/abc123',
);
globalThis.fetch = async () => { throw new Error('no network'); };
assert.strictEqual(
    await service.shortenUrl('https://f2l.reaperzclub.dpdns.org/xp169s9?hash=AgADph&dl=1'),
    'https://f2l.reaperzclub.dpdns.org/xp169s9?hash=AgADph&dl=1',
);
globalThis.fetch = realFetch;
// must go to the next bot, and no link may be sent twice.
const fallbackClient = fakeClient({
    searchMessages: searchMsgs,
    botReplies: {
        cinebox_node1_2gv6_bot: (forwards) => (forwards <= 1
            ? [linkReply('https://cinebox.example.com/dl/abc123')]
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
assert.strictEqual(streamed[0].bot, 'cinebox_node1_2gv6_bot');
assert.strictEqual(streamed[1].bot, 'PublicDirectFileToLinkBot', 'throttled bot must fall through to the next one');
assert.deepStrictEqual(streamed[1].links, ['https://public.example.com/dl/xyz789']);
assert.strictEqual(fallbackClient.calls.forwards.length, 3, 'file 1 -> bot 1, file 2 -> bot 1 (limited) -> bot 2');
assert.ok(
    (fallbackService._limitedUntil.get('cinebox_node1_2gv6_bot') || 0) > Date.now() + 100_000,
    'a throttled bot must stay out for the 2-minute cooldown',
);
const allLinks = fallbackResult.files.flatMap((f) => f.links);
assert.strictEqual(new Set(allLinks).size, allLinks.length, 'no link may be sent twice');

// Quality is matched in memory: the search runs on the title, so the
// wanted quality is picked from what came back.
const qualityClient = fakeClient({
    searchMessages: searchMsgs,
    botReplies: { cinebox_node1_2gv6_bot: () => [linkReply('https://cinebox.example.com/dl/abc123')] },
});
const qualityService = new TelegramMovieService({ createClient: () => qualityClient });
const only720 = await qualityService.searchWithLinks('Hanuman 720p', async () => {});
assert.strictEqual(only720.files.length, 1, '720p asked and present — only the 720p file comes back');
assert.ok(only720.files[0].file.fileName.includes('720p'));
assert.strictEqual(only720.fellBack, false);

// Wanted quality missing — the available quality comes back instead.
const only1080Client = fakeClient({
    searchMessages: [msg(3, 222, 'Hanu-Man 2024 1080p', 'Hanu-Man.2024.1080p.mkv')],
    botReplies: { cinebox_node1_2gv6_bot: () => [linkReply('https://cinebox.example.com/dl/abc123')] },
});
const only1080Service = new TelegramMovieService({ createClient: () => only1080Client });
const fellBack = await only1080Service.searchWithLinks('Hanuman 720p', async () => {});
assert.strictEqual(fellBack.files.length, 1, '720p asked but only 1080p exists — the 1080p file comes back');
assert.ok(fellBack.files[0].file.fileName.includes('1080p'));
assert.strictEqual(fellBack.fellBack, true, 'missing quality must flag the fallback');
assert.strictEqual(fellBack.wantedQuality, '720p');

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
        sent.push({ chatId, text: content.text, edit: !!content.edit });
        return { key: { id: 'x' } };
    },
};
service.shortenUrl = async () => 'https://is.gd/abc123';
await handleTgMovie(sock, 'chat1', 'owner@lid', ['Hanuman', '720p'], { telegramMovieService: service });
const fresh = sent.filter((s) => !s.edit);
assert.strictEqual(fresh.length, 1, 'only one fresh message — everything else must be an edit of it');
assert.ok(fresh[0].text.includes('Searching Universe Database for *Hanuman 720p*'), 'first message must name Universe Database');
const finalText = sent.at(-1)?.text || '';
assert.ok(finalText.includes('Hanu-Man.2024.720p.mkv'), 'final message must list the 720p file');
assert.ok(finalText.includes('https://is.gd/abc123'), 'final message must include the shortened link');
assert.ok(/Sent all links/.test(finalText), 'final message must say all links were sent');

const sent2 = [];
const sock2 = {
    async sendMessage(chatId, content) {
        sent2.push({ chatId, text: content.text });
        return { key: { id: 'x' } };
    },
};
await handleTgMovie(sock2, 'chat1', 'owner@lid', [], { telegramMovieService: service });
assert.ok(/Usage: `\/tgmovie/.test(sent2.at(-1)?.text || ''), 'no query must show usage');

// A query with no quality must not search — it asks for the quality instead.
const sent3 = [];
const sock3 = {
    async sendMessage(chatId, content) {
        sent3.push({ chatId, text: content.text, edit: !!content.edit });
        return { key: { id: 'x' } };
    },
};
const noQualityClient = fakeClient({ searchMessages: searchMsgs });
const noQualityService = new TelegramMovieService({ createClient: () => noQualityClient });
await handleTgMovie(sock3, 'chat1', 'owner@lid', ['Lucifer', 'S01'], { telegramMovieService: noQualityService });
assert.strictEqual(sent3.length, 1, 'no-quality query must send exactly one reply');
assert.ok(/quality/i.test(sent3[0].text), 'reply must ask for the quality');
assert.ok(sent3[0].text.includes('720p'), 'reply must show an example with a quality');
assert.strictEqual(noQualityClient.calls.forwards.length, 0, 'no-quality query must not forward anything');

// Missing quality at the handler level — the available file comes back
// with a note saying the wanted quality was not found.
const sent4 = [];
const sock4 = {
    async sendMessage(chatId, content) {
        sent4.push({ chatId, text: content.text, edit: !!content.edit });
        return { key: { id: 'x' } };
    },
};
const fallbackHandlerService = new TelegramMovieService({ createClient: () => only1080Client });
fallbackHandlerService.shortenUrl = async () => 'https://is.gd/abc123';
await handleTgMovie(sock4, 'chat1', 'owner@lid', ['Hanuman', '720p'], { telegramMovieService: fallbackHandlerService });
const fallbackText = sent4.at(-1)?.text || '';
assert.ok(fallbackText.includes('Hanu-Man.2024.1080p.mkv'), 'fallback reply must list the available 1080p file');
assert.ok(/720p not found/i.test(fallbackText), 'fallback reply must say the wanted quality was not found');

const handled = await handlePendingTelegramInput(
    sock2, 'chat1', 'owner@lid', '12345', { telegramMovieService: loginService },
);
assert.strictEqual(handled, false, 'no pending login on this service — must not consume the message');

console.log('✓ telegram movie search (/tgmovie, /tglink) checks passed');
process.exit(0);
