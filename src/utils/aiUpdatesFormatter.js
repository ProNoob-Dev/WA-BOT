/**
 * Format one AI update as a WhatsApp card with a complete summary and source.
 */

/**
 * @param {{ title: string, url: string, source?: string }} item
 * @param {{
 *   whatHappened?: string,
 *   industryImpact?: string,
 *   studentCareerAngle?: string[],
 *   projectIdea?: string
 * }} card
 */
export function formatAiUpdateMessage(item, card = {}) {
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '⚡ *AI INDUSTRY & CAREER UPDATE*\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    text += `*${item.title}*\n`;
    if (card.whatHappened) {
        text += `\n🧠 *What happened?*\n${card.whatHappened}\n`;
    }
    if (card.industryImpact) {
        text += `\n🏢 *Industry impact*\n${card.industryImpact}\n`;
    }
    if (card.studentCareerAngle?.length) {
        text += '\n🎓 *Student & career angle*\n';
        text += card.studentCareerAngle.map((line) => `• ${line}`).join('\n');
        text += '\n';
    }
    if (card.projectIdea) {
        text += `\n💡 *Project idea*\n${card.projectIdea}\n`;
    }
    if (item.source) {
        text += `\n📰 *Source:* ${item.source}\n`;
    }
    // Full URL remains on its own line so WhatsApp generates a rich preview.
    text += `🔗 *Full preview:* ${item.url}`;
    return text;
}

/**
 * Caption for the image-mode AI update — header, title, what happened, source.
 * Deliberately has NO "Full preview" link line and no item URL: the image
 * carries the visual, and the link stays out of the caption by design.
 */
export function formatAiUpdateImageCaption(item, card = {}) {
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '⚡ *AI INDUSTRY & CAREER UPDATE*\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    text += `*${item.title}*\n`;
    if (card.whatHappened) {
        text += `\n🧠 *What happened?*\n${card.whatHappened}\n`;
    }
    if (item.source) {
        text += `\n📰 *Source:* ${item.source}`;
    }
    return text;
}

/** The rest of the card — sent as a second text message after the image. */
export function formatAiUpdateFollowUp(card = {}) {
    let text = '';
    if (card.industryImpact) {
        text += `🏢 *Industry impact*\n${card.industryImpact}\n`;
    }
    if (card.studentCareerAngle?.length) {
        text += '\n🎓 *Student & career angle*\n';
        text += card.studentCareerAngle.map((line) => `• ${line}`).join('\n');
        text += '\n';
    }
    if (card.projectIdea) {
        text += `\n💡 *Project idea*\n${card.projectIdea}\n`;
    }
    return text.trim();
}
