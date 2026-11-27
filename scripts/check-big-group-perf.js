/**
 * Self-check: big-group cache warm + summarynow ACL + chat-log day count cache.
 */
import assert from 'node:assert/strict';
import { findCommand } from '../src/commands/registry.js';
import GroupManager from '../src/models/GroupManager.js';
import { groupParticipantSnapshot } from '../src/utils/groupParticipantSnapshot.js';

const summaryNow = findCommand('/summarynow');
assert.equal(summaryNow?.role, 'admins', '/summarynow must be admins+owner (admins role)');

const gm = new GroupManager({}, {}, {
    OWNER_NUMBERS: ['9999999999'],
    MODERATOR_NUMBERS: [],
});

const fakeParticipating = {
    '120363@g.us': {
        id: '120363@g.us',
        subject: 'Big Group',
        participants: Array.from({ length: 50 }, (_, i) => ({
            id: `91${String(i).padStart(10, '0')}@s.whatsapp.net`,
            admin: i === 0 ? 'superadmin' : null,
        })),
    },
};

const warmed = gm.warmMetaFromParticipating(fakeParticipating);
assert.equal(warmed, 1);

const meta = await gm.getGroupMetadataCached(
    { groupMetadata: async () => { throw new Error('should use cache'); } },
    '120363@g.us',
);
assert.equal(meta.subject, 'Big Group');
assert.equal(meta.participants.length, 50);

const seeded = groupParticipantSnapshot.seedFromParticipating(fakeParticipating);
assert.equal(seeded, 1);
assert.ok(groupParticipantSnapshot.cloneGroupKeys('120363@g.us').size >= 50);

// Regression: the bot is in 107 groups and the metadata cache used to cap at
// 100 entries, so it thrashed — groups kept getting evicted and every
// privileged command in them paid a full groupMetadata fetch (500–1000+
// participants). 120 groups fetched through the cache must all stay cached.
let fetches = 0;
const countingSock = {
    groupMetadata: async (groupId) => {
        fetches += 1;
        return {
            id: groupId,
            subject: `Group ${groupId}`,
            participants: [{ id: '919999999999@s.whatsapp.net', admin: 'superadmin' }],
        };
    },
};
const gm2 = new GroupManager({}, {}, {
    OWNER_NUMBERS: ['9999999999'],
    MODERATOR_NUMBERS: [],
});
const groupIds = Array.from({ length: 120 }, (_, i) => `120363${String(i).padStart(4, '0')}@g.us`);
for (const gid of groupIds) {
    await gm2.getGroupMetadataCached(countingSock, gid);
}
assert.equal(fetches, 120);
await gm2.getGroupMetadataCached(countingSock, groupIds[0]);
assert.equal(fetches, 120, 'first group must still be cached after 120 groups');

console.log('check-big-group-perf: ok');
