import { Vec3 } from 'vec3';
import { intentionalDive } from './dive_state.js';
import { runtimeValue } from '../runtime_extensions.js';

const configured = Symbol('terrainNavigationConfigured');
export const isVine = block => Boolean(block?.name && /(?:^vine$|_vines?(?:_plant)?$)/.test(block.name));
export const isWater = block => Boolean(block && (block.name === 'water' ||
    block.name === 'flowing_water' || block.isWaterlogged ||
    /^(?:tall_)?seagrass$|^kelp(?:_plant)?$|^bubble_column$/.test(block.name)));

export function configureTerrainMovements(bot, movements) {
    if (!movements || movements[configured]) return movements;
    movements[configured] = true;
    movements.liquidCost = Math.max(movements.liquidCost ?? 1, 3);
    movements.infiniteLiquidDropdownDistance = false;
    // The installed physics engine supports ordinary vines, not hanging cave/Nether vines.
    const supported = new Set(['ladder', 'vine', 'scaffolding'].map(name =>
        bot.registry.blocksByName[name]?.id).filter(Number.isInteger));
    for (const id of movements.climbables ?? []) {
        if (!supported.has(id)) movements.climbables.delete(id);
    }
    movements.exclusionAreasStep?.push(block => isVine(block) ? 3 : 0);
    movements.exclusionAreasStep?.push(block => (bot._terrainAvoid ?? []).some(area =>
        area.until > Date.now() && block.position &&
        Math.abs(block.position.x - area.x) <= 1 && Math.abs(block.position.z - area.z) <= 1 &&
        Math.abs(block.position.y - area.y) <= 2) ? 30 : 0);
    return movements;
}

export function avoidStuckLocation(bot) {
    const p = bot.entity.position;
    bot._terrainAvoid = (bot._terrainAvoid ?? []).filter(area => area.until > Date.now()).slice(-7);
    bot._terrainAvoid.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z),
        until: Date.now() + 90000 });
}

export function installTerrainNavigation(bot) {
    bot.once('login', () => {
        for (const method of ['setMovements', 'getPathTo', 'getPathFromTo']) {
            if (!bot.pathfinder?.[method]) continue;
            const original = bot.pathfinder[method].bind(bot.pathfinder);
            bot.pathfinder[method] = (movements, ...args) =>
                original(configureTerrainMovements(bot, movements), ...args);
        }
        configureTerrainMovements(bot, bot.pathfinder?.movements);
    });
}

export function terrainAt(bot) {
    const position = bot.entity.position;
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    let vine = [feet, head].find(isVine);
    if (!vine) {
        const yaw = bot.entity.yaw || 0;
        const forward = position.offset(-Math.sin(yaw) * 0.8, 0, -Math.cos(yaw) * 0.8);
        vine = [bot.blockAt(forward), bot.blockAt(forward.offset(0, 1, 0))].find(isVine);
    }
    return { water: Boolean(bot.entity.isInWater || isWater(feet) || isWater(head)),
        submerged: isWater(head), vine };
}

export function keepAfloat(bot) {
    const terrain = terrainAt(bot);
    if (intentionalDive(bot)) return false;
    if (terrain.submerged || (terrain.water && !bot.pathfinder?.goal)) {
        // An active path must not suppress swimming up when the head is underwater.
        bot.setControlState('sneak', false);
        bot.setControlState('sprint', false);
        bot.setControlState('jump', true);
        return true;
    }
    return false;
}

// Being in water is normal. Only attempted movement without progress is a stall.
export class WaterProgressTracker {
    constructor(stallMs = 12000) { this.stallMs = stallMs; this.reset(); }
    reset() { this.anchor = null; this.action = null; this.lastProgress = 0; }
    update(bot, terrain, action, now = Date.now()) {
        const controls = bot.controlState ?? {};
        const moving = ['forward', 'back', 'left', 'right'].some(key => controls[key]) ||
            (terrain.submerged && (controls.jump || controls.sneak));
        if (intentionalDive(bot) && bot._intentionalDive.phase === 'holding') {
            this.reset();
            return false;
        }
        if (!terrain.water || !moving || bot.targetDigBlock || bot.currentWindow) {
            this.reset();
            return false;
        }
        const p = bot.entity.position;
        if (!this.anchor || this.action !== action) {
            this.anchor = p.clone();
            this.action = action;
            this.lastProgress = now;
            return false;
        }
        const horizontal = Math.hypot(p.x - this.anchor.x, p.z - this.anchor.z);
        const vertical = Math.abs(p.y - this.anchor.y);
        const progress = runtimeValue('water_progress_blocks', 0.35, bot);
        if (horizontal >= progress || (terrain.submerged && vertical >= progress)) {
            this.anchor = p.clone();
            this.lastProgress = now;
        }
        return now - this.lastProgress >= runtimeValue('water_stall_ms', this.stallMs, bot);
    }
}

const clear = block => block && !isWater(block) && !isVine(block) &&
    block.boundingBox !== 'block' && !['lava', 'fire', 'cactus', 'magma_block'].includes(block.name);

export function nearestShore(bot, radius = 7) {
    const origin = bot.entity.position.floored();
    let best = null;
    let cost = Infinity;
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            if (dx === 0 && dz === 0) continue;
            for (let dy = -1; dy <= 3; dy++) {
                const p = origin.offset(dx, dy, dz);
                const ground = bot.blockAt(p.offset(0, -1, 0));
                if (ground?.boundingBox !== 'block' || ['lava', 'magma_block', 'cactus'].includes(ground.name)) continue;
                if (!clear(bot.blockAt(p)) || !clear(bot.blockAt(p.offset(0, 1, 0)))) continue;
                const candidateCost = dx * dx + dz * dz + Math.abs(dy) * 3;
                if (candidateCost < cost) { best = p.offset(0.5, 0.05, 0.5); cost = candidateCost; }
            }
        }
    }
    return best;
}

export async function recoverTerrain(bot, { swimMs = 6000, tickMs = 100 } = {}) {
    const start = bot.entity.position.clone();
    const terrain = terrainAt(bot);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    try {
        if (terrain.water) {
            const shore = nearestShore(bot);
            if (shore) await bot.lookAt(new Vec3(shore.x, bot.entity.position.y + 0.5, shore.z));
            const deadline = Date.now() + swimMs;
            while (Date.now() < deadline && !bot.interrupt_code) {
                if (!terrainAt(bot).water) return { kind: 'water', success: true };
                bot.setControlState('sneak', false);
                bot.setControlState('sprint', false);
                bot.setControlState('jump', true);
                bot.setControlState('forward', Boolean(shore));
                await new Promise(resolve => setTimeout(resolve, tickMs));
            }
            return { kind: 'water', success: !terrainAt(bot).water,
                surfaced: !terrainAt(bot).submerged, distance: bot.entity.position.distanceTo(start) };
        }
        if (terrain.vine) {
            if (bot.canDigBlock(terrain.vine)) {
                await bot.dig(terrain.vine, true);
                return { kind: 'vine', success: !isVine(bot.blockAt(terrain.vine.position)) };
            }
            const side = nearestShore(bot, 2);
            if (side) {
                await bot.lookAt(side.offset(0, 1, 0));
                bot.setControlState('forward', true);
                bot.setControlState('jump', true);
                const deadline = Date.now() + Math.min(swimMs, 1500);
                while (Date.now() < deadline && !bot.interrupt_code &&
                       bot.entity.position.distanceTo(start) < 1)
                    await new Promise(resolve => setTimeout(resolve, tickMs));
            }
            return { kind: 'vine', success: bot.entity.position.distanceTo(start) >= 0.7 };
        }
        return { kind: 'other', success: false };
    } finally { bot.clearControlStates(); }
}
