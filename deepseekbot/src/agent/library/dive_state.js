import { runtimeValue } from '../runtime_extensions.js';
export function needsAir(bot, depth = 0) {
    if (['creative', 'spectator'].includes(bot.game?.gameMode)) return false;
    const effect = bot.registry?.effectsByName?.WaterBreathing ?? bot.registry?.effectsByName?.water_breathing;
    if (effect && bot.entity.effects?.[effect.id]) return false;
    const oxygen = bot.oxygenLevel;
    const remaining = Number.isFinite(oxygen) ? oxygen * 0.75 :
        Math.max(0, 8 - (Date.now() - (bot._intentionalDive?.started ?? Date.now())) / 1000);
    return remaining <= Math.max(runtimeValue('dive_air_margin_seconds', 5, bot), depth + 2);
}

export function intentionalDive(bot) {
    const dive = bot._intentionalDive;
    return Boolean(dive && dive.until > Date.now() && !bot.interrupt_code &&
        dive.phase !== 'ascending' && bot.health >= dive.health &&
        !needsAir(bot, Math.max(0, dive.startY - bot.entity.position.y)));
}
