/**
 * AiUpdatesController image-mode test — stubbed service, fake socket.
 *
 * Asserts sendItemMessage with imageMode sends { image: Buffer, caption }
 * (caption has NO "Full preview" line and NO item URL) followed by the
 * follow-up text, and falls back to the text+link-preview path when there
 * is no og:image.
 *
 * Usage: node scripts/test-newsimg-aiupdates-controller.js
 */
import AiUpdatesController from '../src/controllers/AiUpdatesController.js';
import { sendTextWithLinkPreview } from '../src/utils/linkPreview.js';

const TC_URL = 'https://techcrunch.com/2026/11/16/california-state-ag-sues-openai-over-rogue-agent-incidents/';
const TC_OG =
    'https://techcrunch.com/wp-content/uploads/2026/11/1920px-Rob_Bonta_at_Central_Bay_Operations_and_Maintenance_Facility_opening_December_2018.jpeg?resize=1200,981';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const item = {
    title: 'California state AG sues OpenAI over rogue agent incidents',
    url: TC_URL,
    source: 'TechCrunch AI',
    category: 'tools',
};
const card = {
    whatHappened: 'California sued OpenAI over a rogue agent incident.',
    industryImpact: 'A ruling could set the first legal precedent for agent accountability.',
    studentCareerAngle: ['Learn how AI agents are evaluated for safety.'],
    projectIdea: 'Build a small agent with a human-approval step for high-stakes actions.',
};

function makeController(ogImage) {
    const ctrl = new AiUpdatesController({ AI_UPDATES_ENABLED: true }, null, null);
    // Stub the service: no LLM call, deterministic card + og:image.
    ctrl.service = {
        async generateCardData() {
            return card;
        },
        async fetchOgImage() {
            return ogImage;
        },
    };
    return ctrl;
}

function makeSock() {
    const sent = [];
    return {
        sent,
        async sendMessage(chatId, content) {
            sent.push({ chatId, ...content });
            return { key: { id: 'test' } };
        },
    };
}

// 1. imageMode with a real og:image — downloads it and sends image + follow-up.
{
    const ctrl = makeController(TC_OG);
    const sock = makeSock();
    const ok = await ctrl.sendItemMessage(sock, '123@g.us', item, { markPosted: false, imageMode: true });
    check('sendItemMessage returns true', ok === true);
    check('2 messages sent (image + follow-up)', sock.sent.length === 2, `got ${sock.sent.length}`);
    const [img, follow] = sock.sent;
    check('first message is an image', Buffer.isBuffer(img.image), img.image ? `${img.image.length} bytes` : 'not an image');
    check('caption has the title', (img.caption || '').includes(item.title));
    check('caption has NO "Full preview" line', !(img.caption || '').includes('Full preview'));
    check('caption has NO item URL', !(img.caption || '').includes(TC_URL));
    check('follow-up is text with industry impact', typeof follow.text === 'string' && follow.text.includes(card.industryImpact));
    check('follow-up has project idea', (follow.text || '').includes(card.projectIdea));
}

// 2. imageMode with NO og:image — falls back to the text + link-preview path.
{
    const ctrl = makeController(null);
    const sock = makeSock();
    const ok = await ctrl.sendItemMessage(sock, '123@g.us', item, { markPosted: false, imageMode: true });
    check('fallback sendItemMessage returns true', ok === true);
    check('fallback sends 1 text message', sock.sent.length === 1, `got ${sock.sent.length}`);
    check('fallback text has "Full preview" line', (sock.sent[0].text || '').includes('Full preview'));
    check('fallback text has the item URL', (sock.sent[0].text || '').includes(TC_URL));
}

// 3. text mode unchanged — same as the fallback path.
{
    const ctrl = makeController(TC_OG);
    const sock = makeSock();
    await ctrl.sendItemMessage(sock, '123@g.us', item, { markPosted: false, imageMode: false });
    check('text mode sends 1 text message', sock.sent.length === 1, `got ${sock.sent.length}`);
    check('text mode has "Full preview" line', (sock.sent[0].text || '').includes('Full preview'));
}

if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nAll AiUpdatesController image checks passed.');
process.exit(0);
