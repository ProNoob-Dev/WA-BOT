/**
 * Self-check: hubcloud TLD auto-detection (no network).
 *
 * 1. TLD extraction + rewrite keep path/query and only touch hubcloud hosts.
 * 2. Learning a live TLD makes canonicalizeHost rewrite stale links to it
 *    (and leaves fresh/other hosts alone).
 * 3. Live-page detection accepts a drive page (a#download) and a video page
 *    (hubcloud.php worker link), rejects 404/parked/challenge pages.
 *
 * Run: node scripts/check-hubcloud-tld.js
 */
import assert from 'node:assert/strict';
import {
    canonicalizeHost,
    hubcloudTldOf,
    isLiveHubcloudPage,
    noteHubcloudTld,
    rewriteHubcloudTld,
} from '../src/services/HdHubBypassService.js';

// TLD extraction
assert.equal(hubcloudTldOf('https://hubcloud.pw/drive/123abc'), 'pw');
assert.equal(hubcloudTldOf('https://hubcloud.ist/video/123abc'), 'ist');
assert.equal(hubcloudTldOf('https://hubdrive.pics/file/123'), '');
assert.equal(hubcloudTldOf('not a url'), '');

// Rewrite keeps path + query, touches only hubcloud hosts
assert.equal(
    rewriteHubcloudTld('https://hubcloud.ist/drive/123abc?x=1', 'pw'),
    'https://hubcloud.pw/drive/123abc?x=1',
);
assert.equal(
    rewriteHubcloudTld('https://hubdrive.pics/file/123', 'pw'),
    'https://hubdrive.pics/file/123',
);

// Before anything is learned, canonicalizeHost leaves hubcloud links alone
// (apart from the pre-existing hubcdn bump, which is unrelated).
assert.equal(
    canonicalizeHost('https://hubcloud.cx/drive/123abc'),
    'https://hubcloud.cx/drive/123abc',
);

// Learn .pw (as a successful fetch / redirect would) → stale links rewrite
noteHubcloudTld('https://hubcloud.pw/drive/123abc');
assert.equal(
    canonicalizeHost('https://hubcloud.cx/drive/123abc'),
    'https://hubcloud.pw/drive/123abc',
);
assert.equal(
    canonicalizeHost('https://hubcloud.foo/video/123abc'),
    'https://hubcloud.pw/video/123abc',
);
// Already-live and unrelated hosts are untouched
assert.equal(
    canonicalizeHost('https://hubcloud.pw/drive/123abc'),
    'https://hubcloud.pw/drive/123abc',
);
assert.equal(
    canonicalizeHost('https://hubdrive.pics/file/123'),
    'https://hubdrive.pics/file/123',
);

// Live-page detection
const driveHtml = '<html><body><a id="download" href="https://gamerxyt.com/hubcloud.php?host=hubvid&id=1">Download</a></body></html>';
const videoHtml = '<html><body><a class="btn btn-primary" href="https://sportverse.cc/hubcloud.php?host=hubvid&id=1">Watch</a></body></html>';
assert.equal(isLiveHubcloudPage(driveHtml), true);
assert.equal(isLiveHubcloudPage(videoHtml), true);
assert.equal(isLiveHubcloudPage('404 ! File Not Found'), false);
assert.equal(isLiveHubcloudPage('<html><head><title>Just a moment...</title></head></html>'), false);
assert.equal(isLiveHubcloudPage(''), false);

console.log('hubcloud TLD auto-detection: ok');
