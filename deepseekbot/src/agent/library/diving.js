import { terrainAt } from './terrain_navigation.js';
import { needsAir } from './dive_state.js';
import { runtimeValue } from '../runtime_extensions.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function surfaceFromWater(bot, { timeoutMs = 20000, tickMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let anchor = bot.entity.position.clone();
    let lastProgress = Date.now();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    try {
        while (!bot.interrupt_code && Date.now() < deadline && bot.isAlive !== false) {
            if (!terrainAt(bot).submerged) return { success: true, surfaced: true };
            bot.setControlState('sneak', false);
            bot.setControlState('jump', true);
            if (bot.entity.position.y > anchor.y + 0.2) {
                anchor = bot.entity.position.clone();
                lastProgress = Date.now();
            }
            if (Date.now() - lastProgress > 4000)
                return { success: false, surfaced: false, reason: '上方可能受阻，未能上浮到空气处，需要另找出口。' };
            await pause(tickMs);
        }
        return { success: false, surfaced: !terrainAt(bot).submerged,
            reason: bot.interrupt_code ? '上浮已中断。' : '未能在限定时间内到达空气处。' };
    } finally { bot.clearControlStates(); }
}

export async function diveUnderwater(bot, depth = 3, seconds = 8, { tickMs = 100, stallMs = 4000 } = {}) {
    if (!Number.isFinite(depth) || depth < 0.5 || depth > 32 ||
        !Number.isFinite(seconds) || seconds < 1 || seconds > 120)
        return { success: false, reason: '潜水深度应为 0.5～32 格，水下活动时间应为 1～120 秒。' };
    if (!terrainAt(bot).water) return { success: false, reason: '当前不在水中，请先到水边并进入水里。' };
    if (bot.interrupt_code) return { success: false, reason: '潜水已中断。' };
    const startY = bot.entity.position.y;
    const targetY = startY - depth;
    const session = { startY, started: Date.now(), health: bot.health, phase: 'descending', until: Date.now() + seconds * 1000 + 1000 };
    const deadline = Date.now() + seconds * 1000;
    let deepest = startY, lastProgress = Date.now(), reached = false, reason = '水下活动时间结束。';
    bot._intentionalDive = session;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    try {
        while (!bot.interrupt_code && Date.now() < deadline && bot.isAlive !== false) {
            const y = bot.entity.position.y;
            if (needsAir(bot, Math.max(0, startY - y))) { reason = '氧气接近预留上浮量，提前换气。'; break; }
            if (bot.health < session.health) { reason = '潜水期间受伤，提前上浮。'; break; }
            if (!terrainAt(bot).water) { reason = '已经离开水域。'; break; }
            if (y < deepest - 0.15) { deepest = y; lastProgress = Date.now(); }
            if (y <= targetY + 0.25) { reached = true; session.phase = 'holding'; }
            if (!reached && Date.now() - lastProgress > runtimeValue('dive_stall_ms', stallMs, bot)) { reason = '下潜没有进展，可能已到水底或受到阻挡。'; break; }
            // Installed physics sinks naturally with jump released; sneak does not add downward force.
            bot.setControlState('sneak', false);
            bot.setControlState('sprint', false);
            bot.setControlState('jump', reached && y < targetY - 0.15);
            await pause(tickMs);
        }
        if (bot.interrupt_code || bot.isAlive === false)
            return { success: false, reached, depth: Math.max(0, startY - deepest), reason: '潜水已中断。' };
        session.phase = 'ascending';
        const surface = await surfaceFromWater(bot, { tickMs });
        return { success: reached && surface.success, reached, depth: Math.max(0, startY - deepest),
            surfaced: surface.surfaced, reason: reason + (surface.success ? ' 已上浮到空气处。' : ' ' + surface.reason) };
    } finally {
        if (bot._intentionalDive === session) delete bot._intentionalDive;
        bot.clearControlStates();
    }
}

export function requestedDiveCommand(message) {
    const text = String(message).trim();
    if (/^(?:你)?(?:请|帮我|先)?(?:上浮|浮上来|上浮换气|上来换气)[。！!\s]*$/.test(text)) return '!surface';
    const match = text.match(/^(?:你)?(?:请|帮我|先)?(?:潜水|下潜)(?:一下)?\s*(?:(\d+(?:\.\d+)?)\s*(?:格|米))?(?:[，,\s]*(?:最多|持续|停留)?\s*(\d+(?:\.\d+)?)\s*秒)?[。！!\s]*$/);
    return match ? `!dive(${match[1] ?? 3}, ${match[2] ?? 8})` : null;
}
