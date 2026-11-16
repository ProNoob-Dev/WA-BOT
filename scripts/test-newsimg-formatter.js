/**
 * AI updates formatter test — image caption has no link, follow-up has the rest.
 *
 * Asserts formatAiUpdateImageCaption contains no "Full preview" line and no
 * item URL, formatAiUpdateFollowUp contains the impact/career/project text,
 * and the text-mode formatAiUpdateMessage still carries the "Full preview" line.
 *
 * Usage: node scripts/test-newsimg-formatter.js
 */
import {
    formatAiUpdateMessage,
    formatAiUpdateImageCaption,
    formatAiUpdateFollowUp,
} from '../src/utils/aiUpdatesFormatter.js';

const item = {
    title: 'California state AG sues OpenAI over rogue agent incidents',
    url: 'https://techcrunch.com/2026/11/16/california-state-ag-sues-openai-over-rogue-agent-incidents/',
    source: 'TechCrunch AI',
};
const card = {
    whatHappened: 'California sued OpenAI over a rogue agent incident.',
    industryImpact: 'A ruling could set the first legal precedent for agent accountability.',
    studentCareerAngle: ['Learn how AI agents are evaluated for safety.'],
    projectIdea: 'Build a small agent with a human-approval step for high-stakes actions.',
};

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const caption = formatAiUpdateImageCaption(item, card);
check('caption has the title', caption.includes(item.title));
check('caption has whatHappened', caption.includes(card.whatHappened));
check('caption has the source', caption.includes('TechCrunch AI'));
check('caption has NO "Full preview" line', !caption.includes('Full preview'));
check('caption has NO item URL', !caption.includes(item.url));

const followUp = formatAiUpdateFollowUp(card);
check('follow-up has industryImpact', followUp.includes(card.industryImpact));
check('follow-up has career angle', followUp.includes(card.studentCareerAngle[0]));
check('follow-up has projectIdea', followUp.includes(card.projectIdea));

const text = formatAiUpdateMessage(item, card);
check('text mode still has "Full preview" line', text.includes('Full preview'));
check('text mode still has the item URL', text.includes(item.url));

check('empty follow-up is an empty string', formatAiUpdateFollowUp({}) === '');

if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nAll formatter checks passed.');
