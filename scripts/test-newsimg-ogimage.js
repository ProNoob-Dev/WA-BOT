/**
 * AI updates og:image test — fetchOgImage against real pages.
 *
 * Asserts the TechCrunch article returns its known og:image URL, and a page
 * with no og:image (example.com) returns null.
 *
 * Usage: node scripts/test-newsimg-ogimage.js
 */
import AiUpdatesService from '../src/services/AiUpdatesService.js';

const TC_URL = 'https://techcrunch.com/2026/11/16/california-state-ag-sues-openai-over-rogue-agent-incidents/';
const EXPECTED_OG =
    'https://techcrunch.com/wp-content/uploads/2026/11/1920px-Rob_Bonta_at_Central_Bay_Operations_and_Maintenance_Facility_opening_December_2018.jpeg?resize=1200,981';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const service = new AiUpdatesService({});

const og = await service.fetchOgImage(TC_URL);
check('TechCrunch article returns its og:image', og === EXPECTED_OG, og || '(null)');

const none = await service.fetchOgImage('https://example.com');
check('example.com (no og:image) returns null', none === null, String(none));

// Cache hit: second call for the same URL returns the same value without refetch.
const ogAgain = await service.fetchOgImage(TC_URL);
check('og:image cache returns the same URL', ogAgain === EXPECTED_OG, ogAgain || '(null)');

if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nAll og:image checks passed.');
