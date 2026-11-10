/**
 * Resolve WhatsApp channel invite codes / URLs to @newsletter JIDs.
 */

import { logger } from './logger.js';
import { isNewsletterChat } from './stickerExtract.js';

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeChannelInviteCode(value) {
    if (!value) {
        return '';
    }
    let code = value.trim();
    code = code.replace(/^https?:\/\/(www\.)?whatsapp\.com\/channel\//i, '');
    code = code.replace(/\/.*$/, '');
    return code;
}

/**
 * @param {string} entry
 * @returns {boolean}
 */
export function isChannelInviteEntry(entry) {
    if (!entry) {
        return false;
    }
    if (isNewsletterChat(entry)) {
        return false;
    }
    return entry.includes('whatsapp.com/channel/') || !entry.includes('@');
}

/**
 * Parse a whatsapp.com/channel/<code>[/<messageId>] link.
 * @param {string} value
 * @returns {{ code: string, messageId: string } | null}
 */
export function parseChannelMessageLink(value) {
    const m = String(value || '').match(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([^\s\/'"]+)(?:\/(\d+))?/i);
    if (!m) return null;
    return { code: m[1], messageId: m[2] || '' };
}

/**
 * All channel-message links in a text (deduped, order preserved).
 * @param {string} text
 * @returns {Array<{ code: string, messageId: string }>}
 */
export function extractChannelMessageLinks(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[^\s"'<>]+/gi)) {
        const parsed = parseChannelMessageLink(m[0]);
        if (!parsed) continue;
        const k = `${parsed.code}/${parsed.messageId}`;
        if (!seen.has(k)) {
            seen.add(k);
            out.push(parsed);
        }
    }
    return out;
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {string} inviteCode
 * @returns {Promise<{ jid: string, name: string } | null>}
 */
export async function resolveChannelInvite(sock, inviteCode) {
    const code = normalizeChannelInviteCode(inviteCode);
    if (!code || !sock?.newsletterMetadata) {
        return null;
    }

    try {
        const meta = await sock.newsletterMetadata('invite', code);
        const jid = meta?.id || meta?.jid || meta?.newsletterJid || '';
        if (!jid || !isNewsletterChat(jid)) {
            logger.warn(`Channel invite ${code} did not return a @newsletter JID`);
            return null;
        }
        const rawName = meta?.name || meta?.thread_metadata?.name;
        const name =
            typeof rawName === 'string'
                ? rawName
                : rawName?.text || rawName?.name || code;

        return { jid, name };
    } catch (error) {
        logger.error(`Failed to resolve channel invite ${code}: ${error.message}`);
        return null;
    }
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {string[]} entries STICKER_SOURCE_CHANNELS (.env values)
 * @returns {Promise<{ jids: string[], resolved: Array<{ input: string, jid: string, name: string }> }>}
 */
export async function resolveChannelSourceEntries(sock, entries) {
    const jids = [];
    const resolved = [];

    for (const entry of entries) {
        if (!entry) {
            continue;
        }

        if (isNewsletterChat(entry)) {
            jids.push(entry);
            resolved.push({ input: entry, jid: entry, name: entry });
            continue;
        }

        if (!isChannelInviteEntry(entry)) {
            continue;
        }

        const hit = await resolveChannelInvite(sock, entry);
        if (hit) {
            jids.push(hit.jid);
            resolved.push({ input: entry, jid: hit.jid, name: hit.name });
        }
    }

    return { jids: [...new Set(jids)], resolved };
}
