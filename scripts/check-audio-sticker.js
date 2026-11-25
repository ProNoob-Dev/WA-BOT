/**
 * Self-check for sound stickers (/astk, also .astk).
 *
 * 1. The Baileys proto patch round-trips Message.audioStickerMessage (134)
 *    and StickerMessage.audioMessage (26) — tags 1074 / 210 on the wire —
 *    without breaking plain messages, and is idempotent.
 * 2. Incoming sound stickers are detected by the extractors.
 * 3. /astk is registered, wired to a handler, and shown in /help.
 * 4. sendAudioSticker uploads both blobs and relays one audioStickerMessage
 *    (mocked socket — no network).
 * 5. The ffmpeg conversion works on a real video: animated 512x512 WebP +
 *    5s Opus-in-Ogg audio; a silent video is rejected cleanly.
 *
 * Run: node scripts/check-audio-sticker.js
 */
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proto } from 'baileys';
import {
    ensureAudioStickerProtoPatched,
    extractAudioStickerFromMessage,
    sendAudioSticker,
} from '../src/utils/audioSticker.js';
import { extractStickerFromMessage } from '../src/utils/stickerExtract.js';
import { isValidWebpBuffer } from '../src/utils/stickerDownload.js';
import {
    COMMAND_REGISTRY,
    HELP_CATEGORY,
    findCommand,
    formatHelpText,
} from '../src/commands/registry.js';
import { COMMAND_HANDLERS } from '../src/controllers/CommandController.js';
import StickerController from '../src/controllers/StickerController.js';
import WhatsAppService from '../src/services/WhatsAppService.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hasBytes(haystack, needle) {
    return Buffer.from(haystack).includes(Buffer.from(needle));
}

// ── 1. proto patch ──────────────────────────────────────────────────────────
ensureAudioStickerProtoPatched();
ensureAudioStickerProtoPatched(); // idempotent

const stickerMessage = {
    url: 'https://mmg.whatsapp.net/direct/sticker',
    mediaKey: Buffer.from('aabbcc', 'hex'),
    fileSha256: Buffer.from('112233', 'hex'),
    mimetype: 'image/webp',
    height: 512,
    width: 512,
    isAnimated: true,
    audioMessage: {
        url: 'https://mmg.whatsapp.net/direct/audio',
        mediaKey: Buffer.from('ddeeff', 'hex'),
        mimetype: 'audio/ogg; codecs=opus',
        seconds: 5,
    },
};
const audioMsg = { audioStickerMessage: { message: { stickerMessage } } };

const encoded = proto.Message.encode(audioMsg).finish();
assert.ok(hasBytes(encoded, [0xb2, 0x08]), 'wire bytes must carry tag 1074 (field 134)');
assert.ok(hasBytes(encoded, [0xd2, 0x01]), 'wire bytes must carry tag 210 (field 26)');

const decoded = proto.Message.decode(encoded);
const inner = decoded.audioStickerMessage?.message?.stickerMessage;
assert.ok(inner, 'decode must recover audioStickerMessage');
assert.strictEqual(inner.mimetype, 'image/webp');
assert.strictEqual(inner.isAnimated, true);
assert.strictEqual(inner.width, 512);
assert.strictEqual(inner.audioMessage?.mimetype, 'audio/ogg; codecs=opus');
assert.strictEqual(inner.audioMessage?.seconds, 5);
assert.strictEqual(inner.audioMessage?.url, 'https://mmg.whatsapp.net/direct/audio');

// plain messages are untouched by the patch
const plain = proto.Message.decode(proto.Message.encode({ conversation: 'hi' }).finish());
assert.strictEqual(plain.conversation, 'hi');
const plainSticker = proto.Message.decode(
    proto.Message.encode({ stickerMessage: { mimetype: 'image/webp' } }).finish(),
);
assert.strictEqual(plainSticker.stickerMessage?.mimetype, 'image/webp');
assert.strictEqual(plainSticker.audioStickerMessage, undefined);

// ── 2. detection ────────────────────────────────────────────────────────────
const incoming = { audioStickerMessage: { message: { stickerMessage } } };
const found = extractAudioStickerFromMessage(incoming);
assert.ok(found, 'audio sticker must be detected');
assert.strictEqual(found.audioMessage.seconds, 5);
assert.strictEqual(extractStickerFromMessage(incoming), stickerMessage);
assert.strictEqual(extractAudioStickerFromMessage({ stickerMessage }), null);
assert.strictEqual(extractAudioStickerFromMessage({ conversation: 'hi' }), null);
assert.strictEqual(extractStickerFromMessage({ stickerMessage }), stickerMessage);

// ── 3. registry / handler / help ────────────────────────────────────────────
const def = findCommand('/astk');
assert.ok(def, '/astk must resolve');
assert.strictEqual(def.key, 'astk');
assert.ok(COMMAND_REGISTRY.some((d) => d.key === 'astk'), 'astk must be registered');
assert.ok(typeof COMMAND_HANDLERS.astk === 'function', 'astk must have a handler');
assert.strictEqual(HELP_CATEGORY.astk, 'sticker');
const help = formatHelpText({
    isStaff: true,
    isPrivileged: true,
    canManageAdmins: true,
    canSetWelcome: true,
    isOwner: true,
    features: { movie: false },
});
assert.ok(help.includes('`/astk`'), 'help must list /astk');

// seconds parsing
const controller = new StickerController();
assert.strictEqual(controller._parseAudioStickerSeconds([]), 5);
assert.strictEqual(controller._parseAudioStickerSeconds(['7']), 7);
assert.strictEqual(controller._parseAudioStickerSeconds(['99']), 10);
assert.strictEqual(controller._parseAudioStickerSeconds(['0']), 1);
assert.strictEqual(controller._parseAudioStickerSeconds(['nope']), 5);

// ── 4. send path (mocked socket, no network) ────────────────────────────────
const webp1x1 = Buffer.from(
    'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    'base64',
);
const oggFake = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 0)]);
const relayed = [];
const fakeSock = {
    user: { id: '1@s.whatsapp.net' },
    waUploadToServer: async () => ({
        mediaUrl: 'https://mmg.whatsapp.net/direct/test',
        directPath: '/test',
    }),
    relayMessage: async (jid, message, opts) => {
        relayed.push({ jid, message, opts });
        return opts.messageId;
    },
    sendMessage: async () => ({}),
};
const quoted = {
    key: { remoteJid: '123@s.whatsapp.net', id: 'CMD1', participant: '123@s.whatsapp.net' },
    message: { conversation: '/astk' },
};
const messageId = await sendAudioSticker(fakeSock, '123@s.whatsapp.net', {
    webpBuffer: webp1x1,
    audioBuffer: oggFake,
    seconds: 5,
    isAnimated: true,
    quoted,
});
assert.ok(typeof messageId === 'string' && messageId.length > 0, 'relay returns a message id');
assert.strictEqual(relayed.length, 1);
assert.strictEqual(relayed[0].jid, '123@s.whatsapp.net');
const sent = relayed[0].message.audioStickerMessage?.message?.stickerMessage;
assert.ok(sent, 'relayed message must be an audioStickerMessage');
assert.strictEqual(sent.mimetype, 'image/webp');
assert.strictEqual(sent.isAnimated, true);
assert.strictEqual(sent.audioMessage?.mimetype, 'audio/ogg; codecs=opus');
assert.strictEqual(sent.audioMessage?.seconds, 5);
assert.strictEqual(sent.contextInfo?.stanzaId, 'CMD1');
const reEncoded = proto.Message.encode(relayed[0].message).finish();
assert.ok(hasBytes(reEncoded, [0xb2, 0x08]), 'relayed message must encode field 134');
assert.ok(hasBytes(reEncoded, [0xd2, 0x01]), 'relayed message must encode field 26');
const reDecoded = proto.Message.decode(reEncoded);
assert.strictEqual(
    reDecoded.audioStickerMessage?.message?.stickerMessage?.audioMessage?.seconds,
    5,
    'relayed message must decode back with its audio',
);

// ── 5. handleAudioSticker validation (no video → clear error, no crash) ────
const sentTexts = [];
const validationSock = {
    user: { id: '1@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
        sentTexts.push(content?.text || '');
        return {};
    },
};
await controller.handleAudioSticker(
    validationSock,
    '123@s.whatsapp.net',
    { key: { remoteJid: '123@s.whatsapp.net', id: 'M1' }, message: { conversation: '/astk' } },
    [],
    '/astk',
);
assert.ok(
    sentTexts.some((t) => t.includes('reply to a video')),
    'non-video reply must be told to reply to a video',
);

// ── 6. ffmpeg conversion on the real video ──────────────────────────────────
const ffmpegStatic = (await import('ffmpeg-static')).default;
const danceClip = path.join(
    rootDir,
    '..',
    'user',
    'media_library',
    'video',
    '71',
    '719e4b16759011c7654c53f87525f005a2e4b96c8c597d66af279a7fec377170.mp4',
);
function ffprobeDuration(file) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegStatic, ['-i', file], (err, _stdout, stderr) => {
            const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr || '');
            if (!m) {
                reject(new Error(`no duration in ffmpeg output for ${file}: ${stderr}`));
                return;
            }
            resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
        });
    });
}
function makeSilentVideo(outPath) {
    return new Promise((resolve, reject) => {
        execFile(
            ffmpegStatic,
            ['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', outPath],
            (err) => (err ? reject(err) : resolve()),
        );
    });
}

if (!fs.existsSync(danceClip)) {
    console.log(`skip: ffmpeg conversion — test clip not found at ${danceClip}`);
} else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astk-check-'));
    try {
        const stickerPath = path.join(tmp, 'out.webp');
        const audioPath = path.join(tmp, 'out.ogg');
        await controller._renderStandardSticker(danceClip, stickerPath, 'crop');
        const webp = fs.readFileSync(stickerPath);
        assert.ok(isValidWebpBuffer(webp), 'rendered sticker must be WebP');
        assert.ok(webp.includes(Buffer.from('ANIM')), 'rendered sticker must be animated');
        const { default: sharp } = await import('sharp');
        const meta = await sharp(webp).metadata();
        assert.strictEqual(meta.width, 512);
        assert.strictEqual(meta.height, 512);

        await controller._extractAudioClip(danceClip, audioPath, 5);
        const ogg = fs.readFileSync(audioPath);
        assert.strictEqual(ogg.subarray(0, 4).toString('ascii'), 'OggS');
        assert.ok(ogg.includes(Buffer.from('OpusHead')), 'audio must be Opus in Ogg');
        const duration = await ffprobeDuration(audioPath);
        assert.ok(Math.abs(duration - 5) < 0.5, `audio must be ~5s, got ${duration}s`);

        // a video with no audio track is rejected with the friendly error
        const silentPath = path.join(tmp, 'silent.mp4');
        await makeSilentVideo(silentPath);
        await assert.rejects(
            controller._extractAudioClip(silentPath, path.join(tmp, 'silent.ogg'), 5),
            /no audio track in video/,
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// ── 7. `.cmd` routing: `.astk` must reach the dispatcher as `/astk` ────────
const dispatched = [];
const mockController = {
    tryHandlePendingInput: async () => false,
    handleCommand: async (_sock, _chatId, command) => {
        dispatched.push(command);
    },
};
const service = new WhatsAppService(mockController, null, null, null, []);
function fakeTextMsg(id, text) {
    return {
        key: { remoteJid: '123@s.whatsapp.net', id, fromMe: false },
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Test',
    };
}
await service.processIncomingMessage(fakeTextMsg('T1', '.astk'));
await service.processIncomingMessage(fakeTextMsg('T2', '.ping'));
await service.processIncomingMessage(fakeTextMsg('T3', '/astk 7'));
await service.processIncomingMessage(fakeTextMsg('T4', '.hello world'));
await service.processIncomingMessage(fakeTextMsg('T5', '.'));
assert.deepStrictEqual(
    dispatched,
    ['/astk', '/ping', '/astk 7'],
    `dot-prefixed commands must dispatch as slash commands, got ${JSON.stringify(dispatched)}`,
);

console.log('✓ audio sticker (.astk) routing checks passed');
// waMessage pulls in messageQueue, whose 5-min cleanup interval keeps the
// event loop alive — same reason other check scripts exit explicitly.
process.exit(0);
