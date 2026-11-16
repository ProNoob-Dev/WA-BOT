/**
 * Live test: HdHubBypassService — gdflix direct-download bypass.
 *
 *   node scripts/test-gdflix-bypass.js [url]
 *
 * Resolves one gdflix /file/ link through bypassSingleLink (the same path
 * /bypass uses) and prints the direct link. Expects a drive.google.com URL
 * for the default link; anything else fails the run.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
import 'dotenv/config';

import { bypassSingleLink } from '../src/services/HdHubBypassService.js';

const url = process.argv[2] || 'https://gdflix.dev/file/qKcy0ZhknWkzFfu';

(async () => {
    try {
        const t0 = Date.now();
        const { title, links } = await bypassSingleLink(url);
        const dt = Date.now() - t0;

        console.log(`title: ${title || '(none)'}`);
        console.log(`resolved ${links.length} link(s) in ${dt}ms`);
        for (const l of links) console.log(`  ${l.label} → ${l.url}`);

        const direct = links.find((l) => /^https:\/\/(drive|docs)\.google\.com\//i.test(l.url));
        if (!direct) {
            console.error('❌ expected a drive.google.com direct link');
            process.exitCode = 1;
            return;
        }
        console.log(`\n✅ gdflix bypass OK → ${direct.url}`);
    } catch (err) {
        console.error('❌ test failed:', err?.stack || err);
        process.exitCode = 1;
    }
})();
