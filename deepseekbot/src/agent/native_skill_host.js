import * as skills from './library/skills.js';
import { Vec3 } from 'vec3';
import { findNearestLoadedBlock } from './library/block_search.js';
import { terrainAt } from './library/terrain_navigation.js';
import { executeMinecraftCommand } from './minecraft_commands.js';

const item = value => value ? { name: value.name, type: value.type, count: value.count } : null;
const coordinates = value => {
    const values = Array.isArray(value) ? value : [value?.x, value?.y, value?.z];
    if (values.length !== 3 || !values.every(Number.isFinite)) throw Error('Expected finite x/y/z coordinates');
    return new Vec3(...values);
};
export function createNativeHost(agent, canceled) {
    const bot = agent.bot;
    const furnaces = new Map();
    let handle = 0;
    const snapshot = () => {
        const inventory = {};
        for (const value of bot.inventory.items()) inventory[value.name] = (inventory[value.name] ?? 0) + value.count;
        const p = bot.entity.position;
        return { position: { x: p.x, y: p.y, z: p.z }, health: bot.health, food: bot.food,
            oxygen: bot.oxygenLevel ?? null, inventory, in_water: terrainAt(bot).water,
            submerged: terrainAt(bot).submerged, empty_slots: bot.inventory.emptySlotCount() };
    };
    async function rpc(method, args) {
        if (canceled()) throw Error('Extension interrupted');
        switch (method) {
            case 'state': return snapshot();
            case 'now': return Date.now();
            case 'log': skills.log(bot, String(args[0]).slice(0, 500)); return true;
            case 'wait': {
                const ms = args[0];
                if (!Number.isFinite(ms) || ms < 0 || ms > 2000) throw Error('wait must be 0..2000 ms per call');
                await new Promise(resolve => setTimeout(resolve, ms)); return true;
            }
            case 'blockAt': {
                const block = bot.blockAt(coordinates(args));
                return block ? { name: block.name, type: block.type, metadata: block.metadata,
                    boundingBox: block.boundingBox, position: { ...block.position } } : null;
            }
            case 'findBlocks': {
                const [name, range, count] = args;
                const id = bot.registry.blocksByName[name]?.id;
                if (!Number.isInteger(id) || !Number.isFinite(range) || range <= 0 || range > 512 ||
                    !Number.isInteger(count) || count < 1 || count > 32) throw Error('Invalid block search');
                const found = await findNearestLoadedBlock(bot, id, range, null, count);
                const blocks = count === 1 ? (found ? [found] : []) : found ?? [];
                return blocks.map(block => ({ name: block.name, type: block.type, position: { ...block.position } }));
            }
            case 'control': {
                if (!['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].includes(args[0]) || typeof args[1] !== 'boolean')
                    throw Error('Invalid Minecraft control');
                bot.setControlState(args[0], args[1]); return true;
            }
            case 'lookAt': await bot.lookAt(coordinates(args)); return true;
            case 'skill': {
                const [name, values] = args;
                if (!Object.hasOwn(skills, name) || typeof skills[name] !== 'function' || !Array.isArray(values)) throw Error('Unknown native Minecraft skill');
                const result = await skills[name](bot, ...values);
                return result === undefined ? null : JSON.parse(JSON.stringify(result));
            }
            case 'command': return executeMinecraftCommand(agent, args[0]);
            case 'openFurnace': {
                if (furnaces.size) throw Error('Close the current furnace before opening another');
                const block = bot.blockAt(coordinates(args[0]));
                if (!block || !['furnace', 'blast_furnace', 'smoker'].includes(block.name)) throw Error('No furnace at this position');
                const furnace = await bot.openFurnace(block);
                const id = ++handle;
                furnaces.set(id, furnace); return id;
            }
            case 'furnace': {
                const [id, operation, name, count] = args;
                const furnace = furnaces.get(id);
                if (!furnace) throw Error('Unknown or closed furnace handle');
                if (operation === 'close') { furnace.close(); furnaces.delete(id); return true; }
                if (operation === 'state') return { input: item(furnace.inputItem()), fuel: item(furnace.fuelItem()), output: item(furnace.outputItem()) };
                if (operation === 'takeOutput') return item(await furnace.takeOutput());
                if (!['putInput', 'putFuel'].includes(operation)) throw Error('Unknown furnace operation');
                const type = bot.registry.itemsByName[name]?.id;
                if (!Number.isInteger(type) || !Number.isInteger(count) || count <= 0 || count > 64) throw Error('Invalid furnace item/count');
                await furnace[operation](type, null, count); return true;
            }
            default: throw Error('Unknown native skill API method: ' + method);
        }
    }
    return { rpc, close() {
        for (const furnace of furnaces.values()) { try { furnace.close(); } catch {} }
        furnaces.clear(); bot.clearControlStates(); bot.pathfinder.setGoal(null);
    } };
}
