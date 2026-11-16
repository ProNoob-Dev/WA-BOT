/**
 * Live + forced test: gdflix reader fallback (production CF-block path).
 *
 *   node scripts/test-gdflix-fallback.js
 *
 * 1. Forced (child process): a local server answers like Cloudflare (403
 *    "Just a moment") on a gdflix.* host — dns.lookup is patched in-process
 *    and the proxy env is cleared so the request reaches the local server.
 *    bypassSingleLink must return empty gracefully (no throw, no hang) and
 *    the run must log the distinct CF-challenge line. The reader proxies
 *    can't help a localhost URL, so empty is the correct result here — this
 *    proves the fallback TRIGGERS and the failure is diagnosed, not that
 *    it recovers.
 * 2. Live: resolveGdflixViaProxy on the real EI5 link must recover the
 *    title + size (urltomarkdown leg) even while jina is 403.
 * 3. Local: gdflixPost against a stub server that mimics the gdflix POST
 *    endpoint (302 -> real handler), fed the REAL page HTML fetched live,
 *    must return the Drive URL — proves key extraction + POST + redirect
 *    follow without needing jina to work.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
import 'dotenv/config';

import axios from 'axios';
import dns from 'node:dns';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bypassSingleLink, resolveGdflixViaProxy, gdflixPost, gdflixTitleFromText } from '../src/services/HdHubBypassService.js';

const EI5 = 'https://gdflix.dev/file/EI5xgZbN4Fqpi2s';
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body>Please verify you are a human</body></html>';
const fail = (m) => { console.error(`❌ ${m}`); process.exitCode = 1; };

// ── Driver branch: runs as a CHILD process (GDFLIX_FALLBACK_DRIVER=1) ──
if (process.env.GDFLIX_FALLBACK_DRIVER) {
    // Proxy env is already cleared by the parent; delete defensively too.
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
    process.env.NO_PROXY = '*';
    process.env.no_proxy = '*';
    // Route the fake gdflix host at the local server (in-process only).
    const origLookup = dns.lookup.bind(dns);
    dns.lookup = (host, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (host === 'gdflix.test') {
            if (opts && opts.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
            return cb(null, '127.0.0.1', 4);
        }
        return origLookup(host, opts, cb);
    };
    const srv = http.createServer((req, res) => {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(CHALLENGE_HTML);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const t0 = Date.now();
    const out = await bypassSingleLink(`http://gdflix.test:${port}/file/FAKE`, 12_000);
    console.log(`RESULT links=${out.links.length} title=${out.title || '(none)'} size=${out.size || '(none)'} dt=${Date.now() - t0}ms`);
    srv.close();
    // pino-pretty flushes async — give the CF-challenge warn line time to land.
    await new Promise((r) => setTimeout(r, 800));
    process.exit(0);
}

// ── Parent: check 1 (forced, via child) ──
{
    const childEnv = { ...process.env };
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete childEnv[k];
    childEnv.NO_PROXY = '*';
    childEnv.no_proxy = '*';
    childEnv.GDFLIX_FALLBACK_DRIVER = '1';
    const out = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: childEnv });
        let buf = '';
        child.stdout.on('data', (d) => { buf += d; });
        child.stderr.on('data', (d) => { buf += d; });
        const to = setTimeout(() => { child.kill(); reject(new Error('driver timed out after 90s')); }, 90_000);
        child.on('close', (code) => { clearTimeout(to); resolve({ code, buf }); });
        child.on('error', reject);
    });
    console.log('--- forced challenge driver output ---');
    console.log(out.buf.trim());
    if (out.code !== 0) fail(`driver exited ${out.code}`);
    if (!/CF challenge page/.test(out.buf)) fail('driver did not log the distinct CF-challenge line');
    if (!/RESULT links=0/.test(out.buf)) fail('driver should resolve to 0 links against a challenge-only server');
    const dt = Number(out.buf.match(/dt=(\d+)ms/)?.[1] || 0);
    if (dt > 75_000) fail(`driver took ${dt}ms (over the 75s bound)`);
}

// ── Parent: check 2 (live proxy meta leg) ──
{
    const t0 = Date.now();
    const via = await resolveGdflixViaProxy(EI5, 9_000);
    console.log(`\nproxy fallback: title=${via.title || '(none)'} size=${via.size || '(none)'} links=${via.links.length} in ${Date.now() - t0}ms`);
    if (!via.title.includes('Family.Full.House')) fail('proxy fallback did not recover the title');
    if (via.size !== '608.02MB') fail(`proxy fallback size: expected 608.02MB, got ${via.size || '(none)'}`);
    for (const l of via.links) {
        if (!/^https:\/\//.test(l.url) || /&amp;/.test(l.url)) fail(`proxy fallback link is not a clean https URL: ${l.url}`);
    }
}

// ── Parent: check 3 (local POST stub + real HTML) ──
{
    const res = await axios.get(EI5, {
        timeout: 15_000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        validateStatus: (s) => (s >= 200 && s < 400) || s === 403,
    });
    const html = typeof res.data === 'string' ? res.data : String(res.data || '');
    if (!gdflixTitleFromText(html).includes('Family.Full.House')) fail('title helper did not parse the real page HTML');
    const wantKey = html.match(/formData\.append\("key",\s*"([^"]+)"\)/)?.[1] || '';
    if (!wantKey) fail('real page HTML has no direct key to test with');
    let seenKey = '';
    let seenAction = '';
    const stub = http.createServer((req, res2) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (req.url === '/file/FAKE') {
                // First POST 302s (gdflix.dev -> mirror host); the client must re-POST.
                res2.writeHead(302, { Location: '/file/FAKE2' });
                return res2.end();
            }
            seenKey = body.match(/name="key"\r\n\r\n([^\r]+)/)?.[1] || body.match(/"key",\s*"([^"]+)"/)?.[1] || '';
            seenAction = /direct/.test(body) ? 'direct' : '';
            res2.writeHead(200, { 'Content-Type': 'application/json' });
            res2.end(JSON.stringify({ url: 'https://drive.google.com/open?id=TEST123' }));
        });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const port = stub.address().port;
    const direct = await gdflixPost(html, `http://127.0.0.1:${port}/file/FAKE`, 9_000);
    stub.close();
    console.log(`\nPOST stub: got ${direct || '(none)'}, action=${seenAction || '(none)'}, key matches=${seenKey === wantKey}`);
    if (direct !== 'https://drive.google.com/open?id=TEST123') fail(`gdflixPost did not follow the 302 and return the Drive URL (got ${direct || '(none)'})`);
    if (seenAction !== 'direct') fail('gdflixPost did not send action=direct');
    if (seenKey !== wantKey) fail('gdflixPost did not send the page key');
}

if (process.exitCode) console.error('\n❌ gdflix fallback test FAILED');
else console.log('\n✅ gdflix fallback OK');
