/**
 * TECH FLASH image test — parseArticles against the REAL live Inshorts page.
 *
 * Asserts every returned article has a non-empty imageUrl starting with
 * https://media.inshorts.com/, title/summary still extracted, and every
 * formatted TECH FLASH message fits WhatsApp's ~1024-char image-caption limit.
 *
 * Usage: node scripts/test-newsimg-inshorts.js
 */
import axios from 'axios';
import InshortsScraper from '../src/services/InshortsScraper.js';
import { formatNewsArticleMessages } from '../src/utils/newsFormatter.js';

const INSHORTS_URL = 'https://inshorts.com/en/read/technology';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const resp = await axios.get(`${INSHORTS_URL}?t=${Date.now()}`, {
    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
});
check('Inshorts page returns HTTP 200', resp.status === 200, `HTTP ${resp.status}`);

const scraper = new InshortsScraper(null);
const articles = scraper.parseArticles(resp.data, { minArticles: 10 });
console.log(`Articles parsed: ${articles.length}`);
check('at least 1 article parsed', articles.length >= 1, `${articles.length} article(s)`);

for (const [i, a] of articles.entries()) {
    check(`article ${i + 1}: title extracted`, Boolean(a.title?.trim()), (a.title || '').slice(0, 60));
    check(`article ${i + 1}: summary extracted`, Boolean(a.summary?.trim()), `${(a.summary || '').length} chars`);
    check(
        `article ${i + 1}: imageUrl is a media.inshorts.com URL`,
        typeof a.imageUrl === 'string' && a.imageUrl.startsWith('https://media.inshorts.com/'),
        a.imageUrl || '(missing)'
    );
}

const messages = formatNewsArticleMessages(articles, 10);
console.log(`Formatted messages: ${messages.length}`);
for (const [i, m] of messages.entries()) {
    check(`message ${i + 1}: caption length <= 1024`, m.length <= 1024, `${m.length} chars`);
}

if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nAll Inshorts image checks passed.');
