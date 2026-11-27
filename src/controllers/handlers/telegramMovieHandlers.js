/**
 * /tglink — owner-only one-time Telegram login for the movie search.
 * /tgmovie — search the owner's Telegram movie channel, forward matches to
 * the link bot, send its links back to WhatsApp.
 */
import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';
import { safeSendMessage, editMessageText } from '../../utils/waMessage.js';

const OWNER_PHONE = String(config.TG_LOGIN_PHONE || '+918830285258').trim();

/** Queued send with a timeout — a raw socket send that hangs must never stall a run. */
function send(sock, chatId, text, originalMsg = null) {
    return safeSendMessage(sock, chatId, { text }, originalMsg || null);
}

/** Edit the progress message in place; a failed edit just skips that update. */
function updateProgress(sock, chatId, key, text) {
    return editMessageText(sock, chatId, key, text, { fallback: false });
}

export async function handleTgLink(sock, chatId, senderJid, ctx, originalMsg = null) {
    const service = ctx.telegramMovieService;
    if (!service) {
        await send(sock, chatId, '❌ Telegram movie search is not set up on this bot yet.', originalMsg);
        return;
    }
    try {
        if (service.isLoggedIn()) {
            await send(sock, chatId, '✅ Telegram is already logged in — try `/tgmovie <name>`.', originalMsg);
            return;
        }
        await service.beginLogin(OWNER_PHONE, chatId, senderJid);
        await send(sock, chatId, '📲 I sent a login code to your Telegram app (number ending 5258).\n\nReply here with the code to finish logging in.', originalMsg);
    } catch (err) {
        logger.warn(`tglink failed: ${err?.message || err}`);
        await send(sock, chatId, `❌ Telegram login could not start: ${err?.message || err}`, originalMsg);
    }
}

/** Plain-text reply handler — consumes the login code / 2FA password. */
export async function handlePendingTelegramInput(sock, chatId, senderJid, messageText, ctx, originalMsg = null) {
    const service = ctx.telegramMovieService;
    if (!service || !service.hasPendingLogin(chatId, senderJid)) return false;
    const text = String(messageText || '').trim();
    if (!text) return false;
    try {
        if (service._login?.needsPassword) {
            const { username, persisted } = await service.completePassword(text);
            await send(sock, chatId, `✅ Logged in to Telegram as @${username}.${persisted ? '' : '\n\n⚠️ I could not save the session to Koyeb — the login lasts until the next restart. Tell me and I will save it.'}\n\nNow try \`/tgmovie <name>\`.`, originalMsg);
            return true;
        }
        const { username, persisted } = await service.completeLogin(text);
        await send(sock, chatId, `✅ Logged in to Telegram as @${username}.${persisted ? '\n\nThe bot will restart once to pick up the saved session — give it a minute, then try `/tgmovie <name>`.' : '\n\n⚠️ I could not save the session to Koyeb — the login lasts until the next restart. Tell me and I will save it.'}`, originalMsg);
        return true;
    } catch (err) {
        if (err?.needsPassword) {
            if (service._login) service._login.needsPassword = true;
            await send(sock, chatId, '🔐 Two-step verification is on — reply with your Telegram password.', originalMsg);
            return true;
        }
        logger.warn(`Telegram login code failed: ${err?.message || err}`);
        await send(sock, chatId, `❌ That code did not work (${err?.message || err}). Run \`/tglink\` again for a fresh code.`, originalMsg);
        return true;
    }
}

export async function handleTgMovie(sock, chatId, senderJid, args, ctx, originalMsg = null) {
    const service = ctx.telegramMovieService;
    if (!service) {
        await send(sock, chatId, '❌ Telegram movie search is not set up on this bot yet.', originalMsg);
        return;
    }
    const query = (args || []).join(' ').trim();
    if (!query) {
        await send(sock, chatId, '🎬 Usage: `/tgmovie <movie or series name>`\n\nExample: `/tgmovie Hanuman`', originalMsg);
        return;
    }
    const progress = await send(sock, chatId, `🔍 Searching Universe Database for *${query}*…`, originalMsg);
    const progressKey = progress?.key || null;
    // One message for the whole run: links keep appending to it, no spam.
    let messageText = `🔍 Searching Universe Database for *${query}*…`;
    const refresh = () => progressKey && updateProgress(sock, chatId, progressKey, messageText);
    let result;
    let sentCount = 0;
    let withLinks = 0;
    try {
        result = await service.searchWithLinks(query, async ({ file, links, bot }, _index, total) => {
            sentCount += 1;
            if (links.length) withLinks += 1;
            messageText += `\n\n📁 *${file.fileName}*`;
            if (links.length) {
                const shortLinks = await Promise.all(links.map((u) => service.shortenUrl(u)));
                messageText += `\n${shortLinks.map((u) => `🔗 ${u}`).join('\n')}`;
            } else messageText += '\n_No link back yet — every link bot was busy or silent. Try again in a bit._';
            await refresh();
        }, async (total) => {
            messageText = `📂 Found ${total} file${total > 1 ? 's' : ''} in Universe Database — sending links…`;
            await refresh();
        });
    } catch (err) {
        logger.warn(`tgmovie search failed for "${query}": ${err?.message || err}`);
        const hint = /not logged in/i.test(String(err?.message || err))
            ? '\n\nRun `/tglink` first (owner only).'
            : '';
        const text = `❌ Search failed: ${err?.message || err}${hint}`;
        if (progressKey) await updateProgress(sock, chatId, progressKey, text);
        else await send(sock, chatId, text, originalMsg);
        return;
    }
    if (!result.files.length) {
        const text = `❌ Nothing found for *${query}* in Universe Database.`;
        if (progressKey) await updateProgress(sock, chatId, progressKey, text);
        else await send(sock, chatId, text, originalMsg);
        return;
    }
    if (withLinks === result.files.length) messageText += '\n\n✅ Sent all links.';
    else messageText += `\n\n⚠️ Sent ${withLinks} of ${result.files.length} links — the rest had no link yet. Try again in a bit.`;
    await refresh();
}
