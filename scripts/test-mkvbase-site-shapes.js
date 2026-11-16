/** Regression tests for the "Love In Sync S01" empty-result bug (16 Nov 2026).
 * 1. _extractJson must accept the flat shape AND wrapped/bare shapes — the old
 *    brace-scan only recognised a top-level {"results": [...]} object, so a
 *    wrapped payload silently dropped every row.
 * 2. _normalizeResults must keep the two real "Love In Sync S01" rows
 *    (gdflix.dev links, odd "AAC2 0 H 264" spacing) instead of dropping them.
 * Run: node scripts/test-mkvbase-site-shapes.js
 */
import { mkvbaseSiteService as svc } from '../src/services/MkvbaseSiteService.js';

const ROWS = [
    { id: '1', title: 'Love In Sync S01 1080p friDay WEB DL AAC2 0 H 264 Marco', url: 'https://gdflix.dev/file/AAAA', status: '1', created_at: '2026-11-16T00:00:00Z' },
    { id: '2', title: 'Love In Sync S01 1080p x264 Korean Esubs', url: 'https://gdflix.dev/file/BBBB', status: '1', created_at: '2026-09-08T00:00:00Z' },
];

let pass = 0, fail = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };

const shapes = {
    'flat {count,results}': JSON.stringify({ count: 2, results: ROWS }),
    'nested {data:{results}}': JSON.stringify({ data: { count: 2, results: ROWS } }),
    'deep {data:{data:{results}}}': JSON.stringify({ data: { data: { results: ROWS } } }),
    'bare rows array': JSON.stringify(ROWS),
    'prefixed JSON': 'while(1);' + JSON.stringify({ count: 2, results: ROWS }),
    'challenge HTML': '<html><head><title>Just a moment...</title></head></html>',
    'empty string': '',
};
for (const [name, body] of Object.entries(shapes)) {
    const r = svc._extractJson(body);
    check(`extractJson ${name}`, name === 'challenge HTML' || name === 'empty string' ? r === null : (r?.results?.length === 2));
}

const norm = svc._normalizeResults({ count: 2, results: ROWS }, 'Love In Sync S01');
check('normalize keeps both real rows', norm.length === 2 && norm[0].pageUrl.includes('gdflix.dev') && norm[1].pageUrl.includes('gdflix.dev'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
