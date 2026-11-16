/** End-to-end test of MkvbaseSiteService against a local stub that mimics
 * mkvbase.site's /api/links handshake + signed search.
 * The stub validates the signature and proof-of-work exactly like the real
 * site (HMAC-SHA256 over q:t:seq:n:ent, sha256 PoW prefix), so a pass proves
 * the service signs requests correctly and parses results into the
 * MovieController shape.
 * Run: MKVBASE_SITE_URL= node scripts/test-mkvbase-site-stub.js
 * (the script sets MKVBASE_SITE_URL to the stub itself)
 */
import http from 'node:http';
import crypto from 'node:crypto';

const CLIENT_KEY = 'cd'.repeat(32);
const SALT = 'stub-salt-9f3a';
const DIFFICULTY = 2;
const SEQ = '1';

function sha256Hex(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

const ROWS = [
    { id: '101', title: 'The Beast (2023) Hindi Dubbed 480p [400MB]', url: 'https://mkvbase.site/the-beast-2023-hindi-dubbed-480p/', status: '1', created_at: '2026-11-16T10:00:00Z' },
    { id: '102', title: 'The Beast (2023) Hindi Dubbed 720p [1.1GB]', url: 'https://mkvbase.site/the-beast-2023-hindi-dubbed-720p/', status: '1', created_at: '2026-11-16T10:05:00Z' },
    { id: '103', title: 'Beast (2022) Hindi Dubbed 1080p [2.4GB]', url: 'https://mkvbase.site/beast-2022-hindi-dubbed-1080p/', status: '1', created_at: '2026-11-16T10:10:00Z' },
];

const challenge = `${SALT}:${DIFFICULTY}:${Date.now() + 25 * 60_000}:stubhmac`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/links') {
        res.writeHead(404).end('not found');
        return;
    }
    // Bare handshake: issue the mkv_* cookies.
    if (!url.searchParams.has('q')) {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': [
                `mkv_client_key=${CLIENT_KEY}; Path=/; HttpOnly`,
                `mkv_challenge=${encodeURIComponent(challenge)}; Path=/; HttpOnly`,
                `mkv_seq=${SEQ}; Path=/; HttpOnly`,
            ],
        }).end(JSON.stringify({ ok: true }));
        return;
    }
    // Signed search: validate sig + pow exactly like the real site.
    const q = url.searchParams.get('q');
    const t = url.searchParams.get('t');
    const seq = url.searchParams.get('seq');
    const pow = url.searchParams.get('pow');
    const ent = url.searchParams.get('ent');
    const sig = url.searchParams.get('sig');
    const expectSig = crypto.createHmac('sha256', CLIENT_KEY).update(`${q}:${t}:${seq}:${pow}:${ent}`, 'utf8').digest('hex');
    if (sig !== expectSig) {
        res.writeHead(403).end(JSON.stringify({ error: 'bad sig' }));
        return;
    }
    const h1 = sha256Hex(`${SALT}:${pow}`);
    if (!sha256Hex(`${h1}:${q}`).startsWith('0'.repeat(DIFFICULTY))) {
        res.writeHead(403).end(JSON.stringify({ error: 'bad pow' }));
        return;
    }
    // Re-issue cookies on every response, like the real site.
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': [
            `mkv_challenge=${encodeURIComponent(challenge)}; Path=/; HttpOnly`,
            `mkv_seq=${SEQ}; Path=/; HttpOnly`,
        ],
    }).end(JSON.stringify({ count: ROWS.length, results: ROWS }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.MKVBASE_SITE_URL = `http://127.0.0.1:${port}`;

const { mkvbaseSiteService } = await import('../src/services/MkvbaseSiteService.js');
const results = await mkvbaseSiteService.searchMovies('the beast', 5);
server.close();

console.log(JSON.stringify(results, null, 2));
const ok = results.length === 3
    && results.every((r) => r.source === 'Mkvbase Site' && r.links.length > 0 && r.pageUrl);
console.log(ok ? 'STUB TEST: PASS' : 'STUB TEST: FAIL');
process.exit(ok ? 0 : 1);
