/**
 * Live + forced test: gdflix mirror-host direct attempt + mirrors-only fallback.
 *
 *   node scripts/test-gdflix-mirror-host.js
 *
 * The parent fetches the REAL EI5 page HTML live (via the egress proxy),
 * then spawns a driver child (same pattern as test-gdflix-fallback.js) whose
 * NO_PROXY covers the fake hosts, so the child's stub + dns patching work
 * while the real urltomarkdown service is still reachable via the proxy.
 *
 * Driver phases (local stub + in-process dns patching simulate a datacenter IP):
 *
 *  A. Entry host challenged, mirror host serves the page, POST works
 *     → 4 links incl. Drive, title + size, no note.
 *  B. Entry host challenged, mirror host serves the page, POST blocked (403)
 *     → 3 mirrors, no Drive link, title + size, note present.
 *  C. Entry + mirror hosts challenged, jina returns the real page HTML with
 *     the Direct Download key stripped → mirrors from the reader HTML, no
 *     Drive link, title + size, note present. (Proves mirrors are no longer
 *     gated on the key.)
 *  D. Entry + mirror hosts challenged, jina down (403) → urltomarkdown on
 *     the known mirror host recovers title + size (links still empty).
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
import 'dotenv/config';

import axios from 'axios';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bypassSingleLink, resolveGdflixViaProxy, gdflixTitleFromText } from '../src/services/HdHubBypassService.js';

const EI5 = 'https://gdflix.dev/file/EI5xgZbN4Fqpi2s';
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body>Please verify you are a human</body></html>';
const HTML_FILE = '/tmp/gdflix-real-ei5.html';
const fail = (m) => { console.error(`❌ ${m}`); process.exitCode = 1; };

// ── Driver branch: runs as a CHILD process (GDFLIX_MIRROR_DRIVER=1) ──
if (process.env.GDFLIX_MIRROR_DRIVER) {
    const realHtml = fs.readFileSync(process.env.GDFLIX_HTML_FILE || HTML_FILE, 'utf-8');
    const realKey = realHtml.match(/formData\.append\("key",\s*"([^"]+)"\)/)?.[1] || '';
    if (!realKey) fail('real page HTML has no direct key');
    const strippedHtml = realHtml.replace(/formData\.append\("key",\s*"[^"]+"\)/g, '');
    if (/formData\.append\("key"/.test(strippedHtml)) fail('key strip failed');

    // Stub server: plays the challenged entry host AND the mirror host.
    const mode = { mirrorGet: 'page', mirrorPost: 'drive', jina: 'real' };
    let mirrorPosts = [];
    const srv = http.createServer((req, res2) => {
        const host = String(req.headers.host || '');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (host.includes('new10.gdflix.io')) {
                if (req.method === 'POST') {
                    mirrorPosts.push(body);
                    if (mode.mirrorPost === 'drive') {
                        res2.writeHead(200, { 'Content-Type': 'application/json' });
                        return res2.end(JSON.stringify({ url: 'https://drive.google.com/open?id=TESTMIRROR' }));
                    }
                    res2.writeHead(403, { 'Content-Type': 'text/html' });
                    return res2.end(CHALLENGE_HTML);
                }
                if (mode.mirrorGet === 'page') {
                    res2.writeHead(200, { 'Content-Type': 'text/html' });
                    return res2.end(realHtml);
                }
                res2.writeHead(403, { 'Content-Type': 'text/html' });
                return res2.end(CHALLENGE_HTML);
            }
            // entry host (gdflix.test / gdflix.dev): always challenged
            res2.writeHead(403, { 'Content-Type': 'text/html' });
            res2.end(CHALLENGE_HTML);
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const FAKE = `http://gdflix.test:${port}/file/EI5xgZbN4Fqpi2s`;

    // dns patch: entry + mirror hosts resolve to the stub.
    const origLookup = dns.lookup.bind(dns);
    dns.lookup = (host, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (host === 'gdflix.test' || host === 'new10.gdflix.io' || host === 'gdflix.dev') {
            if (opts && opts.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
            return cb(null, '127.0.0.1', 4);
        }
        return origLookup(host, opts, cb);
    };

    // fetch patch: only r.jina.ai is faked; everything else is the real fetch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith('https://r.jina.ai/')) {
            if (mode.jina === 'stripped') return new Response(strippedHtml, { status: 200 });
            if (mode.jina === 'down') return new Response('403 Forbidden', { status: 403 });
            return realFetch(url, opts);
        }
        return realFetch(url, opts);
    };

    const checkLinks = (out, want, label) => {
        for (const w of want) {
            const got = out.links.find((l) => l.label === w);
            if (!got) fail(`${label}: missing ${w} link`);
            else if (!/^https:\/\//.test(got.url) || /&amp;/.test(got.url)) fail(`${label}: ${w} URL is not a clean https link: ${got.url}`);
        }
        if (!out.title.includes('Family.Full.House')) fail(`${label}: title missing (got ${out.title || '(none)'})`);
        if (out.size !== '608.02MB') fail(`${label}: size expected 608.02MB, got ${out.size || '(none)'}`);
    };

    // ── Phase A: mirror host serves the page, POST works ──
    {
        mode.mirrorGet = 'page'; mode.mirrorPost = 'drive'; mode.jina = 'real'; mirrorPosts = [];
        const t0 = Date.now();
        const out = await bypassSingleLink(FAKE, 12_000);
        console.log(`\nA mirror+POST: links=${out.links.length} title=${out.title.slice(0, 40)} size=${out.size} note=${out.note || '(none)'} in ${Date.now() - t0}ms`);
        checkLinks(out, ['DriveBot', 'Telegram', 'MGT Server', 'Download'], 'A');
        if (out.note) fail('A: note should be absent when the Drive link was recovered');
        const post = mirrorPosts.join('\n');
        if (!/direct/.test(post)) fail('A: mirror POST did not send action=direct');
        if (!post.includes(realKey)) fail('A: mirror POST did not send the page key');
        if (out.links.find((l) => l.label === 'Download')?.url !== 'https://drive.google.com/open?id=TESTMIRROR') fail('A: Drive link did not come from the mirror POST');
        if (!process.exitCode) console.log('✅ A mirror host serves the page, POST works');
    }

    // ── Phase B: mirror host serves the page, POST blocked ──
    {
        mode.mirrorGet = 'page'; mode.mirrorPost = 'block'; mode.jina = 'real'; mirrorPosts = [];
        const t0 = Date.now();
        const out = await bypassSingleLink(FAKE, 12_000);
        console.log(`\nB mirror, POST blocked: links=${out.links.length} title=${out.title.slice(0, 40)} size=${out.size} note=${out.note || '(none)'} in ${Date.now() - t0}ms`);
        checkLinks(out, ['DriveBot', 'Telegram', 'MGT Server'], 'B');
        if (out.links.find((l) => l.label === 'Download')) fail('B: Download link should not exist when the POST is blocked');
        if (!out.note) fail('B: note missing for mirrors-only result');
        if (!process.exitCode) console.log('✅ B mirrors returned with a note when the POST is blocked');
    }

    // ── Phase C: entry + mirror challenged, jina HTML without the key ──
    {
        mode.mirrorGet = 'challenge'; mode.mirrorPost = 'block'; mode.jina = 'stripped'; mirrorPosts = [];
        const t0 = Date.now();
        const out = await bypassSingleLink(FAKE, 12_000);
        console.log(`\nC challenged + key-stripped reader: links=${out.links.length} title=${out.title.slice(0, 40)} size=${out.size} note=${out.note || '(none)'} in ${Date.now() - t0}ms`);
        checkLinks(out, ['DriveBot', 'Telegram', 'MGT Server'], 'C');
        if (out.links.find((l) => l.label === 'Download')) fail('C: Download link should not exist without the key');
        if (!out.note) fail('C: note missing for mirrors-only result');
        if (mirrorPosts.length) fail(`C: POST should not run without the key (saw ${mirrorPosts.length})`);
        if (!process.exitCode) console.log('✅ C mirrors recovered from reader HTML even without the key');
    }

    // ── Phase D: entry + mirror challenged, jina down → urltomarkdown on mirror host ──
    {
        mode.mirrorGet = 'challenge'; mode.mirrorPost = 'block'; mode.jina = 'down';
        const t0 = Date.now();
        const via = await resolveGdflixViaProxy(EI5, 9_000);
        console.log(`\nD jina down: title=${via.title.slice(0, 40) || '(none)'} size=${via.size || '(none)'} links=${via.links.length} in ${Date.now() - t0}ms`);
        if (!via.title.includes('Family.Full.House')) fail('D: urltomarkdown did not recover the title');
        if (via.size !== '608.02MB') fail(`D: urltomarkdown size: expected 608.02MB, got ${via.size || '(none)'}`);
        if (!process.exitCode) console.log('✅ D urltomarkdown recovers title + size via the mirror host when jina is down');
    }

    srv.close();
    globalThis.fetch = realFetch;
    await new Promise((r) => setTimeout(r, 800));
    if (process.exitCode) console.error('\n❌ gdflix mirror-host test FAILED');
    else console.log('\n✅ gdflix mirror-host test OK');
    process.exit(process.exitCode || 0);
}

// ── Parent: fetch the real page HTML live, then spawn the driver ──
{
    const res = await axios.get(EI5, {
        timeout: 15_000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        validateStatus: (s) => (s >= 200 && s < 400) || s === 403,
    });
    const realHtml = typeof res.data === 'string' ? res.data : String(res.data || '');
    if (!gdflixTitleFromText(realHtml).includes('Family.Full.House')) fail('live fetch did not return the real EI5 page');
    if (!/formData\.append\("key"/.test(realHtml)) fail('real page HTML has no direct key');
    fs.writeFileSync(HTML_FILE, realHtml);

    const noProxy = [process.env.NO_PROXY || '', 'gdflix.test', 'new10.gdflix.io', 'gdflix.dev'].filter(Boolean).join(',');
    const childEnv = { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy, GDFLIX_MIRROR_DRIVER: '1', GDFLIX_HTML_FILE: HTML_FILE };
    const out = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: childEnv });
        let buf = '';
        child.stdout.on('data', (d) => { buf += d; });
        child.stderr.on('data', (d) => { buf += d; });
        const to = setTimeout(() => { child.kill(); reject(new Error('driver timed out after 120s')); }, 120_000);
        child.on('close', (code) => { clearTimeout(to); resolve({ code, buf }); });
        child.on('error', reject);
    });
    console.log('--- mirror-host driver output ---');
    console.log(out.buf.trim());
    if (out.code !== 0) fail(`driver exited ${out.code}`);
    if (!/✅ gdflix mirror-host test OK/.test(out.buf)) fail('driver did not report success');
}

if (process.exitCode) console.error('\n❌ gdflix mirror-host test FAILED');
else console.log('\n✅ gdflix mirror-host test OK');
