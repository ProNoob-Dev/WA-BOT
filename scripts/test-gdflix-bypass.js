/**
 * Live test: HdHubBypassService — gdflix direct-download bypass.
 *
 *   node scripts/test-gdflix-bypass.js [url]
 *
 * Resolves one gdflix /file/ link through bypassSingleLink (the same path
 * /bypass uses) and prints title, size and the mirror list. For the default
 * link it expects the Drive direct link plus the page's mirrors (Telegram,
 * MGT Server, GoFile, DriveBot); for any other URL it only expects a
 * drive.google.com direct link, since other files' mirrors vary.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
import 'dotenv/config';

import { bypassSingleLink } from '../src/services/HdHubBypassService.js';

const url = process.argv[2] || 'https://gdflix.dev/file/qKcy0ZhknWkzFfu';
const isDefault = url === 'https://gdflix.dev/file/qKcy0ZhknWkzFfu';

(async () => {
    try {
        const t0 = Date.now();
        const { title, size, links } = await bypassSingleLink(url);
        const dt = Date.now() - t0;

        console.log(`title: ${title || '(none)'}`);
        console.log(`size: ${size || '(none)'}`);
        console.log(`resolved ${links.length} link(s) in ${dt}ms`);
        for (const l of links) console.log(`  ${l.label} → ${l.url}`);

        const fail = (m) => { console.error(`❌ ${m}`); process.exitCode = 1; };
        if (isDefault) {
            if (!title.includes('Family.Full.House')) fail('expected the file title');
            if (size !== '964.09MB') fail(`expected size 964.09MB, got ${size || '(none)'}`);
            for (const want of ['Telegram', 'MGT Server', 'GoFile', 'DriveBot', 'Download']) {
                const got = links.find((l) => l.label === want);
                if (!got) fail(`missing ${want} mirror`);
                else if (!/^https:\/\//.test(got.url) || /&amp;/.test(got.url)) fail(`${want} URL is not a clean https link: ${got.url}`);
            }
        }
        const direct = links.find((l) => /^https:\/\/(drive|docs)\.google\.com\//i.test(l.url));
        if (!direct) {
            fail('expected a drive.google.com direct link');
        }
        if (process.exitCode) return;
        console.log(`\n✅ gdflix bypass OK → ${direct.url}`);
    } catch (err) {
        console.error('❌ test failed:', err?.stack || err);
        process.exitCode = 1;
    }
})();
