/**
 * Telegram movie search — WA-BOT talks to Telegram as the owner's user
 * account (gramJS / MTProto) so a WhatsApp `/tgmovie <name>` can search the
 * owner's movie channel, forward the matching files to @reaperfiletolinkbot,
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
 * them are forwarded and all of their links come back. Series episodes are
 * separate files and each gets its own links.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { computeCheck } from 'telegram/Password.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const LINK_WAIT_MS = 45_000;
const LINK_POLL_MS = 3_000;
const FORWARD_GAP_MS = 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

export function documentIdOf(message) {
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
    }

    get channelId() {
        return String(config.TG_MOVIE_CHANNEL || '-1001707605233').trim();
    }

    get linkBot() {
        return String(config.TG_LINK_BOT || 'reaperfiletolinkbot').trim();
    }

    isLoggedIn() {
        return Boolean(this._client && this._me);
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
        await client.connect();
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
        await client.connect();
        const sent = await client.invoke(new Api.auth.SendCode({
            phoneNumber: phone,
            apiId,
            apiHash,
            settings: new Api.CodeSettings({}),
        }));
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

    /** Forward one channel file to the link bot and wait for its reply links. */
    async linksForFile(file, channelEntity = null) {
        const client = await this.ensureClient();
        const channel = channelEntity || await this._resolveChannel(client);
        const bot = await client.getEntity(this.linkBot);
        const before = Math.floor(Date.now() / 1000);
        await client.forwardMessages(bot, { messages: [file.messageId], fromPeer: channel });
        const deadline = Date.now() + LINK_WAIT_MS;
        while (Date.now() < deadline) {
            await sleep(LINK_POLL_MS);
            let recent = [];
            try {
                recent = await client.getMessages(bot, { limit: 3 });
            } catch {
                recent = [];
            }
            for (const message of recent) {
                if ((message?.date || 0) <= before) continue;
                const links = extractLinks(message?.message || '');
                if (links.length) return links;
            }
        }
        return [];
    }

    /** Full flow: search, dedupe, forward each file, collect its links. */
    async searchWithLinks(query) {
        const client = await this.ensureClient();
        const channel = await this._resolveChannel(client);
        const found = await client.getMessages(channel, { search: String(query), limit: 20 });
        const files = mediaEntries(found);
        const results = [];
        for (const file of files) {
            let links = [];
            try {
                links = await this.linksForFile(file, channel);
            } catch (err) {
                logger.warn(`Link bot forward failed for ${file.fileName}: ${err?.message || err}`);
            }
            results.push({ file, links });
            await sleep(FORWARD_GAP_MS);
        }
        return { files: results, totalFound: files.length };
    }
}

export default TelegramMovieService;
