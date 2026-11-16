/**
 * Daily AI updates — tools/apps, India-specific AI news, and model releases,
 * one item per scheduled slot. Mirrors GitHubTrendingController.js.
 */

import { logger } from '../utils/logger.js';
import {
    formatAiUpdateMessage,
    formatAiUpdateImageCaption,
    formatAiUpdateFollowUp,
} from '../utils/aiUpdatesFormatter.js';
import { downloadMediaBuffer } from '../utils/downloadMediaBuffer.js';
import { sendTextWithLinkPreview } from '../utils/linkPreview.js';
import AiUpdatesService from '../services/AiUpdatesService.js';
import AssistLlmRouter from '../services/AssistLlmRouter.js';
import OrcaRouterTradeService from '../services/OrcaRouterTradeService.js';

const GROUP_DELAY_MS = 500;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class AiUpdatesController {
    constructor(config, groupManager, aiUpdatesDatabase = null) {
        this.config = config;
        this.groupManager = groupManager;
        this.aiUpdatesDatabase = aiUpdatesDatabase;
        this.service = new AiUpdatesService({
            orca: new OrcaRouterTradeService(config),
            llm: new AssistLlmRouter(config),
        });
    }

    async isSlotDone(slotKey) {
        if (!this.aiUpdatesDatabase) return false;
        return this.aiUpdatesDatabase.isSlotDone(slotKey);
    }

    async markSlotDone(slotKey, meta = {}) {
        if (!this.aiUpdatesDatabase) return;
        await this.aiUpdatesDatabase.markSlotDone(slotKey, meta);
    }

    async sendItemMessage(sock, chatId, item, { markPosted = true, imageMode = false } = {}) {
        if (markPosted && this.aiUpdatesDatabase && (await this.aiUpdatesDatabase.isItemPosted(item.url, chatId))) {
            logger.info(`Skipping duplicate AI update for ${chatId}: ${item.title}`);
            return false;
        }

        const card = await this.service.generateCardData(item);

        if (imageMode) {
            let sentImage = false;
            try {
                const imageUrl = await this.service.fetchOgImage(item.url);
                if (imageUrl) {
                    const buffer = await downloadMediaBuffer(imageUrl);
                    await sock.sendMessage(chatId, {
                        image: buffer,
                        caption: formatAiUpdateImageCaption(item, card),
                    });
                    const followUp = formatAiUpdateFollowUp(card);
                    if (followUp) {
                        await sock.sendMessage(chatId, { text: followUp });
                    }
                    sentImage = true;
                }
            } catch (err) {
                logger.warn(`AI update image failed for "${item.title}": ${err.message} — sending text`);
            }
            if (!sentImage) {
                const text = formatAiUpdateMessage(item, card);
                await sendTextWithLinkPreview(sock, chatId, text, item.url);
            }
        } else {
            const text = formatAiUpdateMessage(item, card);
            await sendTextWithLinkPreview(sock, chatId, text, item.url);
        }

        if (markPosted && this.aiUpdatesDatabase) {
            await this.aiUpdatesDatabase.markItemPosted(item.url, chatId);
        }
        return true;
    }

    async resolveFreshItemForSlot(slotIndex) {
        const targetGroups = await this.groupManager.getAiUpdatesGroups();
        const groupIds = targetGroups.map((g) => g.group_id);

        const candidates = await this.service.fetchForSlot(slotIndex);
        if (!candidates.length) {
            return null;
        }

        if (this.aiUpdatesDatabase && groupIds.length) {
            const fresh = await this.aiUpdatesDatabase.pickFreshItem(candidates, groupIds);
            if (fresh) return fresh;

            const mixed = await this.service.fetchMixedPool();
            return this.aiUpdatesDatabase.pickFreshItem(mixed, groupIds);
        }

        return candidates[0];
    }

    async postItemToGroups(sock, item) {
        const targetGroups = await this.groupManager.getAiUpdatesGroups();
        if (!targetGroups.length) {
            logger.warn('No groups with AI updates enabled. Use /activate and /aiupdateson.');
            return { posted: 0, groups: 0, skipped: 0 };
        }

        let posted = 0;
        let skipped = 0;
        for (const group of targetGroups) {
            try {
                const sent = await this.sendItemMessage(sock, group.group_id, item, {
                    imageMode: group.news_img === true,
                });
                if (sent) {
                    posted++;
                    logger.info(`🤖 AI update posted to ${group.group_name || group.group_id}`);
                } else {
                    skipped++;
                }
                await delay(GROUP_DELAY_MS);
            } catch (err) {
                logger.error(`AI update failed for ${group.group_id}: ${err.message}`);
            }
        }

        return { posted, groups: targetGroups.length, skipped };
    }

    /**
     * Post one fresh item at a scheduled slot (0-based index).
     * @returns {{ posted: number, groups: number, ok: boolean, reason: string, item?: string }}
     */
    async checkAndPostItem(sock, botState, slotIndex) {
        if (!this.config.AI_UPDATES_ENABLED) {
            return { posted: 0, groups: 0, ok: false, reason: 'disabled' };
        }

        if (!sock) {
            logger.info('Waiting for WhatsApp connection (AI updates)...');
            return { posted: 0, groups: 0, ok: false, reason: 'no_sock' };
        }

        try {
            const targetGroups = await this.groupManager.getAiUpdatesGroups();
            if (!targetGroups.length) {
                logger.warn('No groups with AI updates enabled. Use /activate and /aiupdateson.');
                return { posted: 0, groups: 0, ok: false, reason: 'no_groups' };
            }

            const item = await this.resolveFreshItemForSlot(slotIndex);
            if (!item) {
                logger.info(`No fresh AI update for slot ${slotIndex + 1}`);
                return { posted: 0, groups: targetGroups.length, ok: false, reason: 'no_item' };
            }

            logger.info(`AI updates slot ${slotIndex + 1}: ${item.title} (${item.category}, ${item.source})`);

            const { posted, groups } = await this.postItemToGroups(sock, item);
            if (posted > 0) {
                logger.info(`🤖 AI updates #${slotIndex + 1} posted to ${posted}/${groups} group(s)`);
            } else {
                logger.warn(`🤖 AI updates #${slotIndex + 1} sent to 0/${groups} group(s)`);
            }

            if (slotIndex === 0 && this.aiUpdatesDatabase) {
                const removed = await this.aiUpdatesDatabase.cleanupOldPosted(14);
                if (removed > 0) {
                    logger.info(`Cleaned ${removed} old AI updates posted/slot record(s)`);
                }
            }

            return {
                posted,
                groups,
                ok: posted > 0,
                reason: posted > 0 ? 'posted' : 'send_failed',
                item: item.title,
            };
        } catch (err) {
            logger.error(`AI updates slot ${slotIndex + 1} failed: ${err.message}`);
            return { posted: 0, groups: 0, ok: false, reason: 'error' };
        }
    }

    /** Manual preview — does not mark posted. */
    async previewMixed(sock, chatId, limit = 5) {
        const items = await this.service.fetchMixedPool();
        const picked = items.slice(0, limit);
        let imageMode = false;
        try {
            imageMode = await this.groupManager.isNewsImgEnabled(chatId);
        } catch (err) {
            logger.warn(`AI updates preview: news_img lookup failed: ${err.message}`);
        }
        let sent = 0;
        for (const item of picked) {
            const ok = await this.sendItemMessage(sock, chatId, item, { markPosted: false, imageMode });
            if (ok) sent++;
        }
        return { sent, total: picked.length };
    }
}

export default AiUpdatesController;
