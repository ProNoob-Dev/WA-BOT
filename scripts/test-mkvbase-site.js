/** Cross-check the Node protocol port against the harvester's protocol.py.
 * Fixed inputs; both sides must print identical q / pow / sig.
 * Run: node scripts/test-mkvbase-site.js
 * Python side: python3 scripts/test-mkvbase-site.py (same fixed inputs)
 */
import { mkvbaseProtocol } from '../src/services/MkvbaseSiteService.js';

const TERM = 'the beast';
const TS_MS = 1763300000123;
const CLIENT_KEY = 'ab'.repeat(32);
const CHALLENGE = 'deadbeefcafe1234:2:1794836000000:0123456789abcdef';
const SEQ = '1';
const ENT = 10;

const { salt, difficulty } = mkvbaseProtocol.parseChallenge(CHALLENGE);
const qHex = mkvbaseProtocol.xorEncodeHex(TERM, TS_MS);
const nonce = mkvbaseProtocol.solvePow(salt, difficulty, qHex);
const sig = mkvbaseProtocol.searchSignature(CLIENT_KEY, qHex, TS_MS, SEQ, nonce, ENT);
console.log(JSON.stringify({ q: qHex, pow: nonce, sig }, null, 2));
