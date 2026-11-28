/**
 * Telegram movie search — WA-BOT talks to Telegram as the owner's user
 * account (gramJS / MTProto) so a WhatsApp `/tgmovie <name>` can search the
 * owner's movie channel, forward the matching files to @cinebox_node1_2gv6_bot,
 * and send the link bot's reply links back to WhatsApp.
 *
 * Why a user client, not a bot token: a Bot API bot cannot search a private
 * channel's history or read another bot's replies. The user session does both.
 *
 * One-time login (owner only, over WhatsApp): `/tglink` asks Telegram for a
 * code, the owner replies with the code, the session string is saved to the
 * Koyeb service env (TG_SESSION) so later restarts stay logged in.
 *
 * Dedup: the same file reposted in the channel forwards once (matched by
 * Telegram document id). Different qualities are different files, so all of
 * them are forwarded, but only the first link of each comes back — the
 * bot's extra links are mirrors, and the user wants just the download link.
 * Series episodes are separate files and each gets its own links.
 *
 * Link bots: the first bot answers most files, but it throttles (about 2
 * links a minute). When a bot answers with a limit message or stays silent,
 * the file is tried on the next bot in TG_LINK_BOTS instead. Results stream
 * out per file as they arrive — the caller is not kept waiting for the
 * slowest file.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { computeCheck } from 'telegram/Password.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const LINK_POLL_MS = 3_000;
const PER_BOT_WAIT_MS = 60_000;
const LIMIT_COOLDOWN_MS = 120_000;
const FORWARD_GAP_MS = 1_000;
const LIMIT_RE = /limit|flood|too many|try again later|per minute|rate limit|slow down|only \d+ links?|links?\s*\/\s*min/i;
/** A quality token — a search query must carry one, for movies and series alike. */
export const QUALITY_RE = /\b(2160p|1440p|1080p|720p|480p|360p|4k)\b/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reject if the promise does not settle in time — no Telegram call may hang a run forever. */
function withTimeout(promise, ms, label) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/** True when a bot reply says it is throttling (not a normal "please wait"). */
export function isLimitReply(text) {
    return LIMIT_RE.test(String(text || ''));
}

export function extractLinks(text) {
    const seen = new Set();
    const out = [];
    for (const m of String(text || '').matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;]+$/, '');
        if (!seen.has(url)) {
            seen.add(url);
            out.push(url);
        }
    }
    return out;
}

/**
 * Links can live in the message text, in a TextUrl entity (the visible text
 * is just "Download"), or in an inline-keyboard button — FileToLink bots
 * commonly answer with a button and almost no text. Check all three.
 */
export function extractUrlsFromMessage(message) {
    const found = [...extractLinks(message?.message || '')];
    for (const entity of message?.entities || []) {
        if (entity?.className === 'MessageEntityTextUrl' && entity.url) {
            found.push(String(entity.url));
        }
    }
    const rows = message?.reply_markup?.rows || [];
    for (const row of rows) {
        for (const button of row?.buttons || []) {
            if (button?.url) found.push(String(button.url));
        }
    }
    return [...new Set(found)];
}

export function qualityOf(fileName) {
    const m = String(fileName || '').match(QUALITY_RE);
    return m ? m[1].toLowerCase().replace('4k', '2160p') : null;
}

function episodeOf(fileName) {
    const m = String(fileName || '').match(/\bS\d{1,2}E\d{1,2}\b|\bE\d{1,2}\b|\bEpisode\s*\d+\b|\bPart\s*\d+\b/i);
    return m ? m[0].toLowerCase() : '';
}

/**
 * One file per quality — the same movie posted as 720p HDR, 720p 10-bit and
 * 720p HEVC is the same thing to the user. Series episodes and movie parts
 * keep their own slot, and files with no resolution in the name pass through.
 */
export function pickOnePerQuality(files) {
    const seen = new Set();
    return files.filter((file) => {
        const quality = qualityOf(file.fileName);
        if (!quality) return true;
        const key = `${quality}|${episodeOf(file.fileName)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function documentIdOf(message) {
    const id = message?.media?.document?.id;
    return id === undefined || id === null ? null : String(id);
}

export function captionOf(message) {
    return String(message?.message || '').trim();
}

export function fileNameOf(message) {
    const attrs = message?.media?.document?.attributes || [];
    const nameAttr = attrs.find((a) => typeof a?.fileName === 'string' && a.fileName);
    if (nameAttr) return nameAttr.fileName;
    const caption = captionOf(message);
    return caption ? caption.split('\n')[0].slice(0, 80) : `file ${message?.id ?? ''}`;
}

/** Keep file messages (video/document) only, deduped by document id. */
export function mediaEntries(messages) {
    const seen = new Set();
    const out = [];
    for (const message of messages || []) {
        const media = message?.media;
        const isFile = media?.className === 'MessageMediaDocument'
            || media?.className === 'MessageMediaVideo';
        if (!isFile) continue;
        const documentId = documentIdOf(message);
        if (documentId && seen.has(documentId)) continue;
        if (documentId) seen.add(documentId);
        out.push({
            messageId: message.id,
            documentId,
            caption: captionOf(message),
            fileName: fileNameOf(message),
            size: message?.media?.document?.size ?? null,
            date: message?.date ?? null,
        });
    }
    return out;
}

function createGramClient(session, apiId, apiHash) {
    return new TelegramClient(new StringSession(session || ''), apiId, apiHash, {
        connectionRetries: 5,
    });
}

export class TelegramMovieService {
    constructor({ createClient = createGramClient } = {}) {
        this._createClient = createClient;
        this._client = null;
        this._me = null;
        this._login = null;
        this._limitedUntil = new Map();
    }

    get channelId() {
        return String(config.TG_MOVIE_CHANNEL || '-1001707605233').trim();
    }

    get linkBot() {
        return this.linkBots[0];
    }

    get linkBots() {
        const list = String(config.TG_LINK_BOTS || config.TG_LINK_BOT || 'cinebox_node1_2gv6_bot')
            .split(',')
            .map((b) => b.trim())
            .filter(Boolean);
        return list.length ? list : ['cinebox_node1_2gv6_bot'];
    }

    isLoggedIn() {
        return Boolean(this._client && this._me);
    }

    _isLimited(botName) {
        return (this._limitedUntil.get(botName) || 0) > Date.now();
    }

    _markLimited(botName) {
        this._limitedUntil.set(botName, Date.now() + LIMIT_COOLDOWN_MS);
        logger.warn(`tgmovie: @${botName} is throttling — skipping it for ${LIMIT_COOLDOWN_MS / 1000}s`);
    }

    /** Connect with the saved session (if any). Returns true when authorised. */
    async ensureClient() {
        if (this._client && this._me) return this._client;
        const apiId = Number(config.TG_API_ID || 0);
        const apiHash = String(config.TG_API_HASH || '').trim();
        if (!apiId || !apiHash) {
            throw new Error('Telegram API credentials are not set on the service (TG_API_ID / TG_API_HASH).');
        }
        const client = this._createClient(String(config.TG_SESSION || '').trim(), apiId, apiHash);
        await withTimeout(client.connect(), 20_000, 'Telegram connect');
        let me = null;
        try {
            me = await client.getMe();
        } catch {
            me = null;
        }
        if (!me) {
            try { await client.disconnect(); } catch {}
            throw new Error('Telegram session is not logged in — run /tglink first.');
        }
        this._client = client;
        this._me = me;
        return client;
    }

    /** Step 1 of login: ask Telegram for a code. The owner replies with it. */
    async beginLogin(phone, chatId, senderJid) {
        const apiId = Number(config.TG_API_ID || 0);
        const apiHash = String(config.TG_API_HASH || '').trim();
        if (!apiId || !apiHash) {
            throw new Error('Telegram API credentials are not set on the service (TG_API_ID / TG_API_HASH).');
        }
        const client = this._createClient('', apiId, apiHash);
        await withTimeout(client.connect(), 20_000, 'Telegram connect');
        const sent = await withTimeout(client.invoke(new Api.auth.SendCode({
            phoneNumber: phone,
            apiId,
            apiHash,
            settings: new Api.CodeSettings({}),
        })), 20_000, 'Telegram login code');
        this._login = {
            client, phone, phoneCodeHash: sent.phoneCodeHash,
            chatId, senderJid, requestedAt: Date.now(),
        };
        return true;
    }

    hasPendingLogin(chatId, senderJid) {
        return Boolean(this._login
            && this._login.chatId === chatId
            && this._login.senderJid === senderJid
            && Date.now() - this._login.requestedAt < 10 * 60_000);
    }

    /** Step 2 of login: finish with the code Telegram sent. */
    async completeLogin(code) {
        const pending = this._login;
        if (!pending) throw new Error('No login is waiting for a code — run /tglink first.');
        const { client, phone, phoneCodeHash } = pending;
        try {
            await client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash,
                phoneCode: String(code).trim(),
            }));
        } catch (err) {
            if (/SESSION_PASSWORD_NEEDED/.test(String(err?.message || err))) {
                const error = new Error('Two-step verification is on — reply with your Telegram password.');
                error.needsPassword = true;
                throw error;
            }
            throw err;
        }
        return this._finishLogin(client);
    }

    /** Step 3 (only when 2FA is on): finish with the account password. */
    async completePassword(password) {
        const pending = this._login;
        if (!pending) throw new Error('No login is waiting for a password — run /tglink first.');
        const { client } = pending;
        const srp = await client.invoke(new Api.account.GetPassword());
        const check = await computeCheck(srp, String(password));
        await client.invoke(new Api.auth.CheckPassword({ password: check }));
        return this._finishLogin(client);
    }

    async _finishLogin(client) {
        const me = await client.getMe();
        const session = client.session.save();
        this._client = client;
        this._me = me;
        this._login = null;
        const persisted = await this._saveSessionToKoyeb(session);
        return { username: me.username || me.firstName || String(me.id), persisted };
    }

    /** Store the session in the Koyeb service env so restarts stay logged in. */
    async _saveSessionToKoyeb(session) {
        const key = String(config.KOYEB_API_KEY || '').trim();
        const serviceId = String(config.KOYEB_SERVICE_ID || '').trim();
        if (!key || !serviceId) return false;
        try {
            const base = 'https://app.koyeb.com/v1';
            const headers = {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            };
            const deps = await (await fetch(`${base}/deployments?service_id=${serviceId}&limit=1`, { headers })).json();
            const definition = (deps.deployments || [])[0]?.definition;
            if (!definition) return false;
            const env = (definition.env ||= []);
            const entry = env.find((e) => e.key === 'TG_SESSION');
            if (entry) entry.value = session;
            else env.push({ key: 'TG_SESSION', value: session });
            const res = await fetch(`${base}/services/${serviceId}`, {
                method: 'PUT', headers, body: JSON.stringify({ definition }),
            });
            return res.ok;
        } catch (err) {
            logger.warn(`Saving Telegram session to Koyeb failed: ${err?.message || err}`);
            return false;
        }
    }

    async _resolveChannel(client) {
        try {
            return await client.getEntity(this.channelId);
        } catch {
            // Raw ids are not always resolvable — fall back to the dialog list.
            const dialogs = await client.getDialogs({});
            const target = BigInt(this.channelId.replace(/^-100/, ''));
            const found = dialogs.find((d) => {
                const id = d?.entity?.id;
                return id !== undefined && BigInt(id).toString() === target.toString();
            });
            if (!found) throw new Error(`Cannot open Telegram channel ${this.channelId} — is the account a member?`);
            return found.entity;
        }
    }

    /** Search the movie channel; returns deduped file entries, newest first. */
    async searchChannel(query, limit = 20) {
        const client = await this.ensureClient();
        const channel = await this._resolveChannel(client);
        const found = await client.getMessages(channel, { search: String(query), limit });
        return mediaEntries(found);
    }

    /**
     * Shorten a long FileToLink URL before it goes to WhatsApp. Tries ulvis
     * first (it accepts the long plgb links is.gd times out on), then is.gd.
     * Falls back to the original link on any failure — a link is never lost
     * to the shortener.
     */
    async shortenUrl(url) {
        const original = String(url || '');
        const endpoints = [
            `https://ulvis.net/api.php?url=${encodeURIComponent(original)}`,
            `https://is.gd/create.php?format=simple&url=${encodeURIComponent(original)}`,
        ];
        for (const endpoint of endpoints) {
            try {
                const res = await withTimeout(fetch(endpoint), 5_000, 'shorten link');
                const short = String(await res.text()).trim();
                if (/^https?:\/\/\S+$/.test(short)) {
                    logger.info(`tgmovie: shortened ${original.slice(0, 50)}… → ${short}`);
                    return short;
                }
            } catch (err) {
                logger.warn(`tgmovie: shorten failed for ${original.slice(0, 50)}… (${endpoint}): ${err?.message || err}`);
            }
        }
        return original;
    }

    /** Wait for one bot's reply links after a forward. */
    async _waitForLinks(bot, botName, before) {
        const deadline = Date.now() + PER_BOT_WAIT_MS;
        while (Date.now() < deadline) {
            await sleep(LINK_POLL_MS);
            let recent = [];
            try {
                recent = await withTimeout(
                    this._client.getMessages(bot, { limit: 3 }),
                    10_000,
                    'link bot reply read',
                );
            } catch {
                recent = [];
            }
            for (const message of recent) {
                if ((message?.date || 0) <= before) continue;
                const text = String(message?.message || '');
                if (isLimitReply(text)) {
                    logger.info(`tgmovie: @${botName} answered with a limit message`);
                    return { links: [], limited: true };
                }
                // Only the first link per file — the bot's extra links are
                // mirrors/watch links, and the user wants just the download link.
                const links = extractUrlsFromMessage(message).slice(0, 1);
                if (links.length) {
                    logger.info(`tgmovie: @${botName} replied (${message?.id}): ${links.length} link(s)`);
                    return { links, limited: false };
                }
                logger.info(`tgmovie: @${botName} replied (${message?.id}) with no links yet — ${text.slice(0, 120)}`);
            }
        }
        return { links: [], limited: false };
    }

    /**
     * Forward one channel file to a link bot and wait for its reply links.
     * Tries each configured bot in order until one answers; a bot that says
     * it is throttling is skipped for a minute. Returns { links, bot }.
     */
    async linksForFile(file, channelEntity = null) {
        const client = await this.ensureClient();
        const channel = channelEntity || await this._resolveChannel(client);
        for (const botName of this.linkBots) {
            if (this._isLimited(botName)) continue;
            try {
                const bot = await withTimeout(client.getEntity(botName), 15_000, `resolve @${botName}`);
                const before = Math.floor(Date.now() / 1000);
                await withTimeout(
                    client.forwardMessages(bot, { messages: [file.messageId], fromPeer: channel }),
                    15_000,
                    `forward to @${botName}`,
                );
                logger.info(`tgmovie: forwarded ${file.fileName} to @${botName}, waiting for links`);
                const { links, limited } = await this._waitForLinks(bot, botName, before);
                if (links.length) return { links, bot: botName };
                if (limited) {
                    this._markLimited(botName);
                    continue;
                }
                logger.warn(`tgmovie: no links back from @${botName} for ${file.fileName} after ${PER_BOT_WAIT_MS / 1000}s — trying the next bot`);
            } catch (err) {
                logger.warn(`tgmovie: @${botName} failed for ${file.fileName}: ${err?.message || err}`);
            }
        }
        return { links: [], bot: null };
    }

    /**
     * Full flow: search, dedupe, keep one file per quality, forward each
     * file, collect its links. Calls onFile(entry, index, total) as each
     * file finishes and onFound(total) right after the search, so results
     * stream out instead of waiting for the slowest file.
     */
    async searchWithLinks(query, onFile = null, onFound = null) {
        const client = await this.ensureClient();
        const channel = await this._resolveChannel(client);
        // Search by title only and match the quality in memory: when the
        // wanted quality is not in the channel, the available ones come
        // back instead of nothing.
        const wanted = String(query).match(QUALITY_RE)?.[1]?.toLowerCase().replace('4k', '2160p') || null;
        let titleQuery = wanted ? String(query).replace(QUALITY_RE, '').replace(/\s+/g, ' ').trim() : String(query);
        if (!titleQuery) titleQuery = String(query);
        const found = await client.getMessages(channel, { search: titleQuery, limit: 20 });
        let files = pickOnePerQuality(mediaEntries(found));
        let fellBack = false;
        if (wanted) {
            const matching = files.filter((f) => qualityOf(f.fileName) === wanted);
            if (matching.length) files = matching;
            else if (files.length) fellBack = true;
        }
        logger.info(`tgmovie: search "${query}" found ${files.length} file(s) in the channel${fellBack ? ` (no ${wanted} — showing available)` : ''}`);
        if (files.length && onFound) await onFound(files.length, { fellBack, wantedQuality: wanted });
        const results = [];
        for (const [index, file] of files.entries()) {
            logger.info(`tgmovie: fetching links for file ${index + 1}/${files.length}: ${file.fileName}`);
            let entry = { file, links: [], bot: null };
            try {
                const { links, bot } = await this.linksForFile(file, channel);
                entry = { file, links, bot };
            } catch (err) {
                logger.warn(`Link bot forward failed for ${file.fileName}: ${err?.message || err}`);
            }
            results.push(entry);
            if (onFile) await onFile(entry, index, files.length);
            logger.info(`tgmovie: file ${index + 1}/${files.length} done (${entry.links.length} link(s))`);
            await sleep(FORWARD_GAP_MS);
        }
        return { files: results, totalFound: files.length, fellBack, wantedQuality: wanted };
    }
}

export default TelegramMovieService;
