/**
 * WhatsApp sound (audio) stickers on Baileys 7.0.0-rc13.
 *
 * Wire format (WhatsApp Web proto — confirmed against the whatsmeow proto
 * mirror and working Baileys forks, jacktheboss220/WhatsAppBotMultiDevice
 * and Neeraj-x0/X-Asena — since upstream Baileys predates the feature):
 *   Message.audioStickerMessage = 134  (FutureProofMessage, tag 1074)
 *     FutureProofMessage.message = 1    (Message)
 *       Message.stickerMessage         (StickerMessage)
 *         StickerMessage.audioMessage = 26 (AudioMessage, tag 210)
 * The audio is a second encrypted media blob (Opus in Ogg), referenced by
 * the nested AudioMessage exactly like a voice note — never inside the WebP.
 *
 * Stock Baileys drops both fields: its generated encode/decode only know
 * the fields from its bundled proto, so this module wraps the static
 * encode/decode functions to append / recover them. The wraps are skipped
 * automatically if a future Baileys ships the fields (capability probe).
 * The decode wrap also makes incoming sound stickers visible to the bot —
 * without it, Baileys decodes field 134 away and the message looks empty.
 */

import {
    downloadContentFromMessage,
    generateMessageIDV2,
    normalizeMessageContent,
    prepareWAMessageMedia,
    proto,
} from 'baileys';
import { createDownloadContext } from './stickerDownload.js';

const AUDIO_STICKER_FIELD = 134;
const AUDIO_STICKER_TAG = (AUDIO_STICKER_FIELD << 3) | 2; // 1074
const STICKER_AUDIO_FIELD = 26;
const STICKER_AUDIO_TAG = (STICKER_AUDIO_FIELD << 3) | 2; // 210
const AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';

let patched = false;

/** Minimal varint/tag scan — enough to find one length-delimited field. */
function readVarint(buf, pos) {
    let value = 0;
    let shift = 0;
    let b;
    do {
        b = buf[pos++];
        value |= (b & 0x7f) << shift;
        shift += 7;
    } while (b & 0x80);
    return [value, pos];
}

function skipField(buf, pos, wire) {
    switch (wire) {
        case 0:
            return readVarint(buf, pos)[1];
        case 1:
            return pos + 8;
        case 2: {
            const [len, next] = readVarint(buf, pos);
            return next + len;
        }
        case 5:
            return pos + 4;
        default:
            throw new Error(`unsupported wire type ${wire}`);
    }
}

function findLengthDelimitedField(buf, start, end, fieldNo) {
    let pos = start;
    while (pos < end) {
        const [tag, afterTag] = readVarint(buf, pos);
        pos = afterTag;
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field === fieldNo && wire === 2) {
            const [len, afterLen] = readVarint(buf, pos);
            return buf.subarray(afterLen, afterLen + len);
        }
        pos = skipField(buf, pos, wire);
    }
    return null;
}

/**
 * Raw bytes behind a decode() call: either a Uint8Array, or a protobufjs
 * Reader ({ buf, pos, len }) positioned at the message start.
 */
function decodeBytes(reader, length) {
    if (reader && typeof reader.pos === 'number' && reader.buf) {
        const start = reader.pos;
        const end = length === undefined ? reader.len : Math.min(reader.len, start + length);
        return { buf: reader.buf, start, end };
    }
    const buf = Buffer.isBuffer(reader) ? reader : Buffer.from(reader);
    return { buf, start: 0, end: length === undefined ? buf.length : length };
}

function upstreamHasStickerAudio() {
    try {
        const bytes = proto.Message.StickerMessage.encode({
            audioMessage: { mimetype: AUDIO_MIMETYPE, seconds: 5 },
        }).finish();
        return bytes.length > 0;
    } catch {
        return false;
    }
}

function upstreamHasAudioStickerMessage() {
    try {
        const bytes = proto.Message.encode({
            audioStickerMessage: { message: { conversation: 'x' } },
        }).finish();
        return bytes.length > 0;
    } catch {
        return false;
    }
}

/**
 * Patch Baileys' proto encode/decode for sound stickers. Idempotent; a
 * no-op when upstream Baileys already carries the fields.
 */
export function ensureAudioStickerProtoPatched() {
    if (patched) {
        return;
    }
    patched = true;

    if (!upstreamHasStickerAudio()) {
        const origEncode = proto.Message.StickerMessage.encode;
        proto.Message.StickerMessage.encode = function (message, writer) {
            writer = origEncode.call(this, message, writer);
            if (message?.audioMessage) {
                proto.Message.AudioMessage.encode(
                    message.audioMessage,
                    writer.uint32(STICKER_AUDIO_TAG).fork(),
                ).ldelim();
            }
            return writer;
        };

        const origDecode = proto.Message.StickerMessage.decode;
        proto.Message.StickerMessage.decode = function (reader, length) {
            const { buf, start, end } = decodeBytes(reader, length);
            const msg = origDecode.call(this, reader, length);
            try {
                const raw = findLengthDelimitedField(buf, start, end, STICKER_AUDIO_FIELD);
                if (raw) {
                    msg.audioMessage = proto.Message.AudioMessage.decode(raw);
                }
            } catch {
                // keep the sticker even if the audio sidecar is malformed
            }
            return msg;
        };
    }

    if (!upstreamHasAudioStickerMessage()) {
        const origEncode = proto.Message.encode;
        proto.Message.encode = function (message, writer) {
            writer = origEncode.call(this, message, writer);
            if (message?.audioStickerMessage) {
                proto.Message.FutureProofMessage.encode(
                    message.audioStickerMessage,
                    writer.uint32(AUDIO_STICKER_TAG).fork(),
                ).ldelim();
            }
            return writer;
        };

        const origDecode = proto.Message.decode;
        proto.Message.decode = function (reader, length) {
            const { buf, start, end } = decodeBytes(reader, length);
            const msg = origDecode.call(this, reader, length);
            try {
                const raw = findLengthDelimitedField(buf, start, end, AUDIO_STICKER_FIELD);
                if (raw) {
                    msg.audioStickerMessage = proto.Message.FutureProofMessage.decode(raw);
                }
            } catch {
                // keep the message even if the audio-sticker wrapper is malformed
            }
            return msg;
        };
    }
}

/**
 * @param {import('baileys').proto.Message | null | undefined} message
 * @returns {{ stickerMessage: object, audioMessage: object } | null}
 */
export function extractAudioStickerFromMessage(message) {
    ensureAudioStickerProtoPatched();
    if (!message) {
        return null;
    }
    const content = normalizeMessageContent(message);
    const stickerMessage = content?.audioStickerMessage?.message?.stickerMessage;
    if (!stickerMessage?.audioMessage) {
        return null;
    }
    return { stickerMessage, audioMessage: stickerMessage.audioMessage };
}

/**
 * Download the audio sidecar of an incoming sound sticker.
 * @param {import('baileys').WASocket} sock
 * @param {object} audioMessage
 * @returns {Promise<Buffer>}
 */
export async function downloadAudioStickerAudio(sock, audioMessage) {
    const stream = await downloadContentFromMessage(
        audioMessage,
        'audio',
        createDownloadContext(sock),
    );
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) {
        throw new Error('empty audio sticker audio');
    }
    return buffer;
}

/**
 * Send a sound sticker: upload the WebP and the Opus audio as two media
 * blobs, then relay them as one audioStickerMessage. Uses relayMessage
 * directly — sendMessage has no content type for this message.
 *
 * @param {import('baileys').WASocket} sock
 * @param {string} jid
 * @param {{ webpBuffer: Buffer, audioBuffer: Buffer, seconds?: number,
 *   isAnimated?: boolean, quoted?: object, ephemeralExpiration?: number }} opts
 * @returns {Promise<string>} message id
 */
export async function sendAudioSticker(sock, jid, {
    webpBuffer,
    audioBuffer,
    seconds = 5,
    isAnimated = true,
    quoted = null,
    ephemeralExpiration = 0,
} = {}) {
    ensureAudioStickerProtoPatched();
    if (!sock?.waUploadToServer || !sock?.relayMessage) {
        throw new Error('socket cannot upload/relay media');
    }

    const upload = sock.waUploadToServer;
    const stickerMedia = await prepareWAMessageMedia({ sticker: webpBuffer }, { upload });
    const audioMedia = await prepareWAMessageMedia(
        { audio: audioBuffer, mimetype: AUDIO_MIMETYPE, seconds },
        { upload },
    );

    const stickerMessage = stickerMedia.stickerMessage;
    stickerMessage.mimetype = 'image/webp';
    stickerMessage.isAnimated = isAnimated;
    stickerMessage.width = 512;
    stickerMessage.height = 512;
    stickerMessage.audioMessage = audioMedia.audioMessage;

    if (quoted?.key && quoted?.message) {
        stickerMessage.contextInfo = {
            stanzaId: quoted.key.id,
            participant: quoted.key.participant || quoted.key.remoteJid,
            quotedMessage: quoted.message,
        };
    }

    const message = {
        audioStickerMessage: { message: { stickerMessage } },
    };
    if (ephemeralExpiration) {
        message.messageContextInfo = { ephemeralExpiration };
    }

    const messageId = generateMessageIDV2();
    await sock.relayMessage(jid, message, { messageId });
    return messageId;
}
