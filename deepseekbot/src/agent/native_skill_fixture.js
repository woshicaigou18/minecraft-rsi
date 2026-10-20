// Test-world model only; never touches the connected Minecraft world.
export function createNativeFixture(initial = {}) {
    let time = 0, equipped = null, nextHandle = 0;
    const state = { position: { x: 0, y: 64, z: 0 }, inventory: {}, health: 20, food: 20,
        oxygen: 20, in_water: false, submerged: false, empty_slots: 4, ...structuredClone(initial) };
    if (Array.isArray(state.position)) state.position = {x: state.position[0], y: state.position[1], z: state.position[2]};
    if (initial.in_water === undefined && state.submerged) state.in_water = true;
    const blocks = [...(initial.blocks ?? [])];
    const furnaces = new Map();
    const handles = new Map();
    const recipes = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
        beef: 'cooked_beef', chicken: 'cooked_chicken', sand: 'glass' };
    function tick() {
        for (const furnace of furnaces.values()) {
            if (furnace.input && furnace.fuel && time >= furnace.ready) {
                furnace.output = { name: recipes[furnace.input.name] ?? 'unknown', count: furnace.input.count };
                furnace.input = null;
            }
        }
    }
    async function rpc(method, args = []) {
        tick();
        switch (method) {
            case 'state': return structuredClone(state);
            case 'now': return time;
            case 'log': return true;
            case 'wait':
                if (!Number.isFinite(args[0]) || args[0] < 0 || args[0] > 2000) throw Error('Invalid wait');
                time += args[0]; tick(); return true;
            case 'blockAt': return structuredClone(blocks.find(block =>
                block.position.x === args[0] && block.position.y === args[1] && block.position.z === args[2]) ?? { name: 'air', position: { x: args[0], y: args[1], z: args[2] } });
            case 'findBlocks': return structuredClone(blocks.filter(block => block.name === args[0]).slice(0, args[2] ?? 8));
            case 'lookAt': return true;
            case 'control':
                if (args[0] === 'jump' && args[1] && state.submerged) { state.position.y++; state.submerged = false; }
                return true;
            case 'skill': {
                const [name, values] = args;
                if (name === 'equip') { if (!state.inventory[values[0]]) return false; equipped = values[0]; return true; }
                if (name === 'collectBlock') {
                    const [type, count] = values;
                    if (state.empty_slots === 0) return false;
                    state.inventory[type] = (state.inventory[type] ?? 0) + count; return true;
                }
                if (name === 'discard') {
                    const [type, count] = values;
                    if (count <= 0 || count > (state.inventory[type] ?? 0)) return false;
                    state.inventory[type] -= count; state.empty_slots++; return true;
                }
                if (name === 'goToPosition') { state.position = { x: values[0], y: values[1], z: values[2] }; return true; }
                if (name === 'placeBlock') {
                    const [type, x, y, z] = values;
                    if (!(state.inventory[type] > 0)) return false;
                    state.inventory[type]--; blocks.push({ name: type, position: { x, y, z } }); return true;
                }
                if (name === 'smeltItem') {
                    const [type, count] = values;
                    if (!recipes[type] || (state.inventory[type] ?? 0) < count) return false;
                    state.inventory[type] -= count;
                    state.inventory[recipes[type]] = (state.inventory[recipes[type]] ?? 0) + count; return true;
                }
                throw Error('Fixture has no native skill model: ' + name);
            }
            case 'openFurnace': {
                const p = args[0];
                const found = blocks.find(block => block.name === 'furnace' && block.position.x === p.x && block.position.y === p.y && block.position.z === p.z);
                if (!found) throw Error('Fixture furnace is missing');
                const key = JSON.stringify(p);
                if (!furnaces.has(key)) furnaces.set(key, {});
                const id = ++nextHandle; handles.set(id, furnaces.get(key)); return id;
            }
            case 'furnace': {
                const [id, operation, name, count] = args;
                const furnace = handles.get(id);
                if (!furnace) throw Error('Closed furnace');
                if (operation === 'close') { handles.delete(id); return true; }
                if (operation === 'state') return { input: furnace.input ?? null, fuel: furnace.fuel ?? null, output: furnace.output ?? null };
                if (operation === 'takeOutput') {
                    const output = furnace.output;
                    if (!output) throw Error('No furnace output');
                    state.inventory[output.name] = (state.inventory[output.name] ?? 0) + output.count;
                    furnace.output = null; return output;
                }
                if (!Number.isInteger(count) || count <= 0 || count > (state.inventory[name] ?? 0)) throw Error('Missing furnace items');
                state.inventory[name] -= count;
                if (operation === 'putInput') { furnace.input = { name, count }; furnace.ready = time + count * 10000; return true; }
                if (operation === 'putFuel') { furnace.fuel = { name, count }; return true; }
                throw Error('Unknown furnace operation');
            }
            default: throw Error('Fixture does not implement API method: ' + method);
        }
    }
    return { rpc, state };
}
