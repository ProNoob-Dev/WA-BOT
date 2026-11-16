/**
 * NewsController image-mode test — real Inshorts articles, fake socket.
 *
 * Asserts sendArticleMessages with imageMode sends { image: Buffer, caption }
 * per article (downloading the real article photo), and falls back to text
 * for an article with no imageUrl.
 *
 * Usage: node scripts/test-newsimg-newscontroller.js
 */
import axios from 'axios';
import InshortsScraper from '../src/services/InshortsScraper.js';
import NewsController from '../src/controllers/NewsController.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const resp = await axios.get(`https://inshorts.com/en/read/technology?t=${Date.now()}`, {
    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
});
const scraper = new InshortsScraper(null);
const articles = scraper.parseArticles(resp.data, { minArticles: 3 });
check('3 real articles parsed', articles.length === 3, `${articles.length} article(s)`);

const sent = [];
const sock = {
    async sendMessage(chatId, content) {
        sent.push({ chatId, ...content });
        return { key: { id: 'test' } };
    },
};
const marked = [];
const newsDatabase = {
    async isNewsPosted() {
        return false;
    },
    async markNewsPosted(titles, groupId) {
        marked.push({ titles, groupId });
    },
};
const controller = new NewsController(newsDatabase, scraper, { NEWS_MIN_ARTICLES: 10 }, null);

const count = await controller.sendArticleMessages(sock, '123@g.us', articles, {
    markPosted: true,
    imageMode: true,
});
check('sendArticleMessages returns the message count', count === 3, `got ${count}`);
check('3 messages sent', sent.length === 3, `got ${sent.length}`);
for (const [i, m] of sent.entries()) {
    check(`message ${i + 1}: sent as image`, Buffer.isBuffer(m.image), m.image ? `${m.image.length} bytes` : 'not an image');
    check(`message ${i + 1}: caption has TECH FLASH numbering`, /\/3/.test(m.caption || ''), (m.caption || '').slice(0, 40));
    check(`message ${i + 1}: caption has the headline`, (m.caption || '').includes(articles[i].title.slice(0, 30)));
}
check('markNewsPosted called with all titles', marked.length === 1 && marked[0].titles.length === 3);

// Fallback: article with no imageUrl goes out as text.
sent.length = 0;
const noImage = [{ title: 'No photo story', summary: 'A story with no photo.', imageUrl: null }];
await controller.sendArticleMessages(sock, '123@g.us', noImage, { markPosted: false, imageMode: true });
check('no-image article falls back to text', sent.length === 1 && typeof sent[0].text === 'string' && !sent[0].image);

if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nAll NewsController image checks passed.');
process.exit(0);
