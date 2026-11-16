/**
 * Mkvbase.site direct search — the site's own signed /api/links API.
 * Protocol reverse-engineered from the site's Next.js client (same protocol
 * as the Pro-MovieAPiDrive harvester):
 *
 *   Session: bare GET /api/links sets mkv_client_key / mkv_challenge / mkv_seq.
 *   Search:  GET /api/links?q=..&t=..&seq=..&pow=..&ent=..&sig=..
 *     q   = hex(utf8(term) XOR (t % 256)), t = Date.now()
 *     pow = nonce with sha256(sha256("salt:nonce") + ":" + q) starting with "0"*difficulty
 *     sig = HMAC-SHA256(client_key, "q:t:seq:n:ent")
 *
 * Cloudflare fronts the site: the handshake needs either the owner's skip-rule
 * header (MKV_ORIGIN_KEY, sent as MKV_ORIGIN_HEADER, default X-Mkv-Key) or an
 * egress IP Cloudflare does not challenge. Fetches go through PROXY_URL when
 * set (same proxy-agent mechanism as the gdflix bypass). Without either, the
 * handshake 403s and searchMovies returns [] — the vault API stays the
 * primary mkvbase source and this one is an additional, fail-soft source.
 *
 * Env:
 *   MKVBASE_SITE_URL    (default https://mkvbase.site — override for tests)
 *   MKV_ORIGIN_KEY      (optional — owner's Cloudflare skip-rule secret)
 *   MKV_ORIGIN_HEADER   (default X-Mkv-Key)
 *   MKVBASE_SITE_TIMEOUT_MS (default 15000)
 */

import crypto from 'node:crypto';
import axios from 'axios';
import { ProxyAgent } from 'proxy-agent';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { audioFromFilename, qualityFromFilename } from '../utils/movieMetadata.js';

const DEFAULT_BASE_URL = 'https://mkvbase.site';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const REQUEST_TIMEOUT = 15000;
const SEARCH_CACHE_MAX = 200;
const SEARCH_CACHE_TTL_MS = 60 * 1000;
const MAX_LINKS_PER_TITLE = 8;
const SIZE_RE = /(\d+(?:\.\d+)?\s?(?:GB|MB))\b/i;
const CHALLENGE_RE = /just a moment|cf-browser-verification|attention required/i;
const MAX_POW_ITERS = 2_000_000;

/** File size embedded in the title ("1.4GB"), when the source lists one. */
function sizeFromTitle(title) {
    const m = SIZE_RE.exec(String(title || ''));
    return m ? m[1].replace(/\s+/, ' ') : '';
}

function sha256Hex(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmacSha256Hex(key, msg) {
    return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

function xorEncodeHex(term, tsMs) {
    const k = tsMs % 256;
    const bytes = Buffer.from(String(term), 'utf8');
    for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= k;
    return bytes.toString('hex');
}

function parseChallenge(challenge) {
    const parts = decodeURIComponent(challenge).split(':');
    if (parts.length !== 4) throw new Error(`bad challenge shape: ${String(challenge).slice(0, 40)}...`);
    return { salt: parts[0], difficulty: parseInt(parts[1], 10), expiryMs: parseInt(parts[2], 10) };
}

function solvePow(salt, difficulty, dataHex) {
    const prefix = '0'.repeat(difficulty);
    for (let nonce = 0; nonce < MAX_POW_ITERS; nonce += 1) {
        const h1 = sha256Hex(`${salt}:${nonce}`);
        if (sha256Hex(`${h1}:${dataHex}`).startsWith(prefix)) return nonce;
    }
    throw new Error(`proof-of-work exhausted (${MAX_POW_ITERS} iterations, difficulty ${difficulty})`);
}

function searchSignature(clientKey, qHex, tsMs, seq, nonce, ent) {
    return hmacSha256Hex(clientKey, `${qHex}:${tsMs}:${seq}:${nonce}:${ent}`);
}

class MkvbaseSiteService {
    constructor() {
        this.name = 'Mkvbase Site';
        /** @type {Map<string, { results: Array, at: number }>} */
        this._searchCache = new Map();
        this._keepAliveTimer = null;
        /** @type {{ clientKey: string, challenge: string, seq: string, cookies: Map<string, string>, expiresAt: number } | null} */
        this._session = null;
        this._handshakePromise = null;
        this._proxyAgent = null;
        this._proxyState = 'unchecked'; // 'unchecked' | 'on' | 'off' | 'bad'
    }

    _base() {
        return (process.env.MKVBASE_SITE_URL || config.MKVBASE_SITE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    }

    _timeoutMs() {
        return config.MKVBASE_SITE_TIMEOUT_MS || REQUEST_TIMEOUT;
    }

    /** Outbound proxy for mkvbase.site fetches (PROXY_URL env). Same mechanism
     * as the gdflix bypass: ProxyAgent takes options, NOT a URL string, and
     * axios needs `proxy: false` or it discards the supplied httpsAgent. */
    _proxyAgentFor() {
        if (this._proxyState !== 'unchecked') return this._proxyState === 'on' ? this._proxyAgent : null;
        const raw = (config.PROXY_URL || '').trim();
        if (!raw) { this._proxyState = 'off'; return null; }
        try {
            const u = new URL(raw);
            if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error('proxy URL needs http(s)://host');
            this._proxyAgent = new ProxyAgent({ getProxyForUrl: () => raw });
            this._proxyState = 'on';
            return this._proxyAgent;
        } catch {
            this._proxyState = 'bad';
            logger.warn('[MkvbaseSite] PROXY_URL is set but malformed — mkvbase fetches will go direct');
            return null;
        }
    }

    _proxyOpts() {
        const agent = this._proxyAgentFor();
        if (!agent) return {};
        logger.info('[MkvbaseSite] mkvbase.site using proxy egress');
        return { httpAgent: agent, httpsAgent: agent, proxy: false };
    }

    _headers() {
        const headers = {
            'User-Agent': DEFAULT_UA,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: '*/*',
            Referer: `${this._base()}/`,
        };
        const key = (config.MKV_ORIGIN_KEY || '').trim();
        if (key) headers[(config.MKV_ORIGIN_HEADER || 'X-Mkv-Key').trim() || 'X-Mkv-Key'] = key;
        return headers;
    }

    _cookieHeader() {
        if (!this._session) return '';
        return [...this._session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    _absorbCookies(setCookie) {
        if (!this._session || !setCookie) return;
        const list = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const entry of list) {
            const pair = String(entry).split(';')[0].trim();
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            const k = pair.slice(0, eq).trim();
            const v = pair.slice(eq + 1).trim();
            if (k && v) this._session.cookies.set(k, v);
        }
        // Re-issued cookies refresh the challenge / sequence.
        const ch = this._session.cookies.get('mkv_challenge');
        const seq = this._session.cookies.get('mkv_seq');
        if (ch) this._session.challenge = ch;
        if (seq) this._session.seq = seq;
        const ck = this._session.cookies.get('mkv_client_key');
        if (ck) this._session.clientKey = ck;
        try {
            const { expiryMs } = parseChallenge(this._session.challenge);
            this._session.expiresAt = expiryMs;
        } catch { /* keep previous expiry */ }
    }

    _sessionReady() {
        const s = this._session;
        if (!s || !s.clientKey || !s.challenge) return false;
        return Date.now() < s.expiresAt - 30_000; // 30s safety margin
    }

    async _handshake() {
        if (this._handshakePromise) return this._handshakePromise;
        this._handshakePromise = (async () => {
            const started = Date.now();
            const res = await axios.get(`${this._base()}/api/links`, {
                timeout: this._timeoutMs(),
                headers: this._headers(),
                validateStatus: () => true,
                responseType: 'text',
                maxRedirects: 3,
                ...this._proxyOpts(),
            });
            const body = typeof res.data === 'string' ? res.data : String(res.data || '');
            if (res.status !== 200 || CHALLENGE_RE.test(body.slice(0, 2000).toLowerCase())) {
                throw new Error(`handshake HTTP ${res.status}`);
            }
            this._session = {
                clientKey: '', challenge: '', seq: '1',
                cookies: new Map(), expiresAt: 0,
            };
            this._absorbCookies(res.headers['set-cookie']);
            const s = this._session;
            if (!s.cookies.get('mkv_client_key') || !s.cookies.get('mkv_challenge')) {
                this._session = null;
                throw new Error('handshake set no mkv_* cookies');
            }
            s.clientKey = s.cookies.get('mkv_client_key');
            s.challenge = s.cookies.get('mkv_challenge');
            s.seq = s.cookies.get('mkv_seq') || '1';
            try {
                s.expiresAt = parseChallenge(s.challenge).expiryMs;
            } catch {
                s.expiresAt = Date.now() + 25 * 60_000;
            }
            logger.info(`[MkvbaseSite] session ready in ${Date.now() - started}ms`);
            return true;
        })();
        try {
            return await this._handshakePromise;
        } finally {
            this._handshakePromise = null;
        }
    }

    async _ensureSession() {
        if (this._sessionReady()) return true;
        await this._handshake();
        return this._sessionReady();
    }

    _buildSearchUrl(term) {
        const s = this._session;
        const tsMs = Date.now();
        const { salt, difficulty } = parseChallenge(s.challenge);
        const qHex = xorEncodeHex(term, tsMs);
        const nonce = solvePow(salt, difficulty, qHex);
        const ent = 10;
        const sig = searchSignature(s.clientKey, qHex, tsMs, s.seq, nonce, ent);
        return `${this._base()}/api/links?q=${qHex}&t=${tsMs}&seq=${encodeURIComponent(s.seq)}&pow=${nonce}&ent=${ent}&sig=${sig}`;
    }

    _extractJson(text) {
        if (!text) return null;
        const start = text.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        for (let i = start; i < text.length; i += 1) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        const obj = JSON.parse(text.slice(start, i + 1));
                        if (obj && typeof obj === 'object' && 'results' in obj) return obj;
                    } catch { /* keep scanning */ }
                }
            }
        }
        return null;
    }

    async _searchOnce(term) {
        await this._ensureSession();
        const url = this._buildSearchUrl(term);
        const headers = this._headers();
        const cookie = this._cookieHeader();
        if (cookie) headers.Cookie = cookie;
        const res = await axios.get(url, {
            timeout: this._timeoutMs(),
            headers,
            validateStatus: () => true,
            responseType: 'text',
            maxRedirects: 3,
            ...this._proxyOpts(),
        });
        this._absorbCookies(res.headers['set-cookie']);
        const body = typeof res.data === 'string' ? res.data : String(res.data || '');
        if (res.status === 403) {
            this._session = null;
            throw new Error('search HTTP 403 (clearance dead)');
        }
        if (res.status !== 200) throw new Error(`search HTTP ${res.status}`);
        const obj = this._extractJson(body);
        if (!obj) {
            if (body.slice(0, 200).toLowerCase().includes('<html')) {
                this._session = null;
                throw new Error('search returned challenge HTML (no JSON)');
            }
            throw new Error('search returned no JSON with results');
        }
        return obj;
    }

    /** Word-overlap score of a title against the query (0..1). */
    _score(title, words) {
        if (!words.length) return 0;
        const t = String(title || '').toLowerCase();
        let hits = 0;
        for (const w of words) {
            if (t.includes(w)) hits += 1;
        }
        return hits / words.length;
    }

    /**
     * Group flat site rows ({id,title,url,...}) into MovieController-compatible
     * grouped results, best-matching titles first.
     */
    _normalizeResults(payload, query) {
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        const words = String(query || '')
            .toLowerCase()
            .split(/\s+/)
            .map((w) => w.replace(/[^a-z0-9]/g, ''))
            .filter((w) => w.length > 2);

        const byTitle = new Map();
        for (const row of rows) {
            if (!row?.url) continue;
            const url = String(row.url).startsWith('http')
                ? String(row.url)
                : `${this._base()}${String(row.url).startsWith('/') ? '' : '/'}${row.url}`;
            const title = String(row.title || url).trim() || 'Unknown';
            if (!byTitle.has(title)) byTitle.set(title, []);
            byTitle.get(title).push({ ...row, url });
        }

        const results = [];
        for (const [title, links] of byTitle) {
            const ordered = links.slice(0, MAX_LINKS_PER_TITLE);
            if (!ordered.length) continue;
            const quality = qualityFromFilename(title);
            const fileSize = sizeFromTitle(title);
            results.push({
                title,
                source: 'Mkvbase Site',
                pageUrl: ordered[0].url,
                links: ordered.map((row) => ({
                    size: quality && fileSize ? `${quality} • ${fileSize}` : (quality || fileSize || 'Open page'),
                    audio: audioFromFilename(title),
                    url: row.url,
                    rawFilename: title,
                })),
            });
        }

        results.sort((a, b) => this._score(b.title, words) - this._score(a.title, words));
        return results;
    }

    /**
     * Search mkvbase.site directly — grouped results compatible with MovieController.
     * Fail-soft: returns [] when the site cannot be reached (Cloudflare, no
     * session) so the other sources still answer.
     * @param {string} query
     * @param {number} maxResults
     */
    async searchMovies(query, maxResults = 5) {
        const q = String(query || '').trim();
        if (!q) return [];

        const cacheKey = q.toLowerCase();
        const cached = this._searchCache.get(cacheKey);
        if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
            logger.info(`[MkvbaseSite] cache hit for "${q}" (${cached.results.length} results)`);
            return cached.results.slice(0, maxResults);
        }

        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const started = Date.now();
                const payload = await this._searchOnce(q);
                const normalized = this._normalizeResults(payload, q);
                const results = normalized.slice(0, maxResults);
                logger.info(
                    `[MkvbaseSite] ${results.length}/${normalized.length} grouped from ` +
                    `${payload?.count ?? payload?.results?.length ?? 0} rows for "${q}" ` +
                    `in ${Date.now() - started}ms (attempt ${attempt})`,
                );
                if (normalized.length) {
                    if (this._searchCache.size >= SEARCH_CACHE_MAX) {
                        this._searchCache.delete(this._searchCache.keys().next().value);
                    }
                    this._searchCache.set(cacheKey, { results: normalized, at: Date.now() });
                }
                return results;
            } catch (err) {
                lastErr = err;
                logger.warn(`[MkvbaseSite] attempt ${attempt} failed for "${q}": ${err?.message || err}`);
                if (attempt < 2) {
                    this._session = null; // fresh handshake on retry
                    await new Promise((r) => setTimeout(r, 1200));
                }
            }
        }

        logger.warn(`[MkvbaseSite] gave up for "${q}": ${lastErr?.message || lastErr}`);
        return [];
    }

    async _headCheck() {
        try {
            return await this._ensureSession();
        } catch {
            return false;
        }
    }

    startKeepAlive(intervalMs = 4 * 60 * 1000) {
        this.stopKeepAlive();
        const ping = async () => {
            const ok = await this._headCheck();
            if (ok) {
                logger.info('[MkvbaseSite] keep-alive OK (session live)');
            } else {
                logger.warn('[MkvbaseSite] keep-alive failed (no session)');
            }
        };
        void ping();
        this._keepAliveTimer = setInterval(() => { void ping(); }, intervalMs);
    }

    stopKeepAlive() {
        if (this._keepAliveTimer) {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
    }
}

export const mkvbaseSiteService = new MkvbaseSiteService();
export default MkvbaseSiteService;

/** Pure protocol helpers, exported for tests (signing must match protocol.py). */
export const mkvbaseProtocol = {
    sha256Hex, hmacSha256Hex, xorEncodeHex, parseChallenge, solvePow, searchSignature,
};
