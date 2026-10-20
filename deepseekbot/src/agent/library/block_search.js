import { Vec3 } from 'vec3';
import { performance } from 'node:perf_hooks';
import { runtimeValue } from '../runtime_extensions.js';

// Search loaded sections only, yielding for movement, chat and both heartbeats.
export async function findNearestLoadedBlock(bot, ids, range, predicate = null, count = 1) {
    const point = bot.entity.position.floored();
    const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
    let best = null;
    const matches = [];
    let bestSquared = range * range;
    let sliceStart = performance.now();
    const yieldIfNeeded = async () => {
        if (performance.now() - sliceStart >= runtimeValue('search_slice_ms', 4, bot)) {
            await new Promise(resolve => setImmediate(resolve));
            sliceStart = performance.now();
        }
    };
    const sections = [];
    const minimumY = bot.game.minY ?? -64;
    const axisDistance = (p, start) => Math.max(start - p, 0, p - start - 15);
    for (const { chunkX, chunkZ, column } of bot.world.getColumns()) {
        if (bot.interrupt_code) return null;
        const x = Number(chunkX) * 16, z = Number(chunkZ) * 16;
        const dx = axisDistance(point.x, x), dz = axisDistance(point.z, z);
        if (dx * dx + dz * dz > bestSquared) continue;
        for (let index = 0; index < column.sections.length; index++) {
            const section = column.sections[index];
            if (!section) continue;
            const y = minimumY + index * 16;
            const dy = axisDistance(point.y, y);
            const distance = dx * dx + dy * dy + dz * dz;
            if (distance <= bestSquared) sections.push({ x, y, z, distance, section });
        }
        await yieldIfNeeded();
    }
    sections.sort((a, b) => a.distance - b.distance);
    for (const entry of sections) {
        if (bot.interrupt_code) return null;
        if (entry.distance > bestSquared) break;
        const palette = entry.section.palette;
        if (palette && !palette.some(state => {
            const type = bot.registry.blocksByStateId[state]?.id;
            return type === undefined || wanted.has(type);
        })) { await yieldIfNeeded(); continue; }
        const cursor = new Vec3(0, 0, 0);
        for (let x = entry.x; x < entry.x + 16; x++) {
            for (let y = entry.y; y < entry.y + 16; y++) {
                for (let z = entry.z; z < entry.z + 16; z++) {
                    const distance = (x - point.x) ** 2 + (y - point.y) ** 2 + (z - point.z) ** 2;
                    if (distance > bestSquared) continue;
                    cursor.set(x, y, z);
                    const block = bot.blockAt(cursor, false);
                    if (block && wanted.has(block.type) && (!predicate || predicate(block))) {
                        if (count === 1) {
                            best = block;
                            bestSquared = distance;
                            if (distance === 0) return best;
                        } else {
                            matches.push({ block, distance });
                            matches.sort((a, b) => a.distance - b.distance);
                            if (matches.length > count) matches.length = count;
                            if (matches.length === count) bestSquared = matches.at(-1).distance;
                        }
                    }
                }
                await yieldIfNeeded();
                if (bot.interrupt_code) return null;
            }
        }
    }
    return count === 1 ? best : matches.map(row => row.block);
}
