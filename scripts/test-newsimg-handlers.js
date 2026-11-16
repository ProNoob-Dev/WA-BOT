/**
 * /newsimgon + /newsimgoff handler test — fake sock + in-memory group store.
 *
 * Asserts the toggle sets the news_img flag, replies with a confirmation card
 * naming TECH FLASH and AI updates (and the reverse command), and refuses
 * non-activated groups with the GROUP NOT ACTIVATED card.
 *
 * Usage: node scripts/test-newsimg-handlers.js
 */
import { handleNewsImgOn, handleNewsImgOff } from '../src/controllers/handlers/groupHandlers.js';

const GROUP_ID = '1234567890-1234567890@g.us';
const SENDER = '919999999999@s.whatsapp.net';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

function makeStore({ active = true } = {}) {
    const flags = new Map();
    return {
        active,
        flags,
        async isGroupActive() {
            return this.active;
        },
        async setNewsImgEnabled(groupId, groupName, enabled, setBy) {
            flags.set(groupId, { news_img: enabled, group_name: groupName, news_img_by: setBy });
        },
        async isNewsImgEnabled(groupId) {
            if (!this.active) return false;
            return flags.get(groupId)?.news_img === true;
        },
    };
}

function makeSock() {
    const sent = [];
    return {
        sent,
        async sendMessage(chatId, content) {
            sent.push({ chatId, text: content.text || '', image: Boolean(content.image) });
            return { key: { id: 'test' } };
        },
        async groupMetadata() {
            return { subject: 'Test Group' };
        },
    };
}

// 1. /newsimgon on an active group
{
    const gm = makeStore({ active: true });
    const sock = makeSock();
    await handleNewsImgOn(sock, GROUP_ID, SENDER, { groupManager: gm, originalMsg: null });
    check('/newsimgon sets news_img=true', (await gm.isNewsImgEnabled(GROUP_ID)) === true);
    const reply = sock.sent.at(-1)?.text || '';
    check('/newsimgon reply says NEWS IMAGES ON', reply.includes('NEWS IMAGES ON'));
    check('/newsimgon reply names TECH FLASH', reply.includes('TECH FLASH'));
    check('/newsimgon reply names AI updates', reply.includes('AI updates'));
    check('/newsimgon reply points to /newsimgoff', reply.includes('/newsimgoff'));
}

// 2. /newsimgoff after on
{
    const gm = makeStore({ active: true });
    const sock = makeSock();
    await handleNewsImgOn(sock, GROUP_ID, SENDER, { groupManager: gm, originalMsg: null });
    await handleNewsImgOff(sock, GROUP_ID, SENDER, { groupManager: gm, originalMsg: null });
    check('/newsimgoff sets news_img=false', (await gm.isNewsImgEnabled(GROUP_ID)) === false);
    const reply = sock.sent.at(-1)?.text || '';
    check('/newsimgoff reply says NEWS IMAGES OFF', reply.includes('NEWS IMAGES OFF'));
    check('/newsimgoff reply points to /newsimgon', reply.includes('/newsimgon'));
}

// 3. /newsimgoff when already off
{
    const gm = makeStore({ active: true });
    const sock = makeSock();
    await handleNewsImgOff(sock, GROUP_ID, SENDER, { groupManager: gm, originalMsg: null });
    const reply = sock.sent.at(-1)?.text || '';
    check('/newsimgoff when off replies ALREADY OFF', reply.includes('ALREADY OFF'));
    check('/newsimgoff when off does not set flag', (await gm.isNewsImgEnabled(GROUP_ID)) === false);
}

// 4. /newsimgon on a non-activated group
{
    const gm = makeStore({ active: false });
    const sock = makeSock();
    await handleNewsImgOn(sock, GROUP_ID, SENDER, { groupManager: gm, originalMsg: null });
    const reply = sock.sent.at(-1)?.text || '';
    check('non-activated group gets GROUP NOT ACTIVATED', reply.includes('GROUP NOT ACTIVATED'));
    check('non-activated group flag stays off', (await gm.isNewsImgEnabled(GROUP_ID)) === false);
}

if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nAll handler checks passed.');
