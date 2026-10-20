import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { configureTerrainMovements, keepAfloat, recoverTerrain, avoidStuckLocation } from '../src/agent/library/terrain_navigation.js';
import { initModes } from '../src/agent/modes.js';

const air = { name: 'air', boundingBox: 'empty' };
let wet = true;
let vine = false;
let cleared = 0;
let canceled = 0;
const controls = {};
const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5), yaw: 0 },
    registry: { blocksByName: { ladder: { id: 1 }, vine: { id: 2 }, cave_vines: { id: 3 } } },
    pathfinder: { goal: {}, setGoal(goal) { assert.equal(goal, null); canceled++; this.goal = goal; } },
    blockAt(p) {
        if (p.y < 1) return { name: 'stone', boundingBox: 'block', position: p.floored() };
        if (p.x < 1 && p.x >= 0 && p.z < 1 && p.z >= 0 && p.y < 3) {
            if (vine) return { name: 'vine', boundingBox: 'empty', position: p.floored() };
            if (wet) return { name: 'water', boundingBox: 'empty', position: p.floored() };
        }
        return air;
    },
    setControlState(name, value) {
        controls[name] = value;
        if (name === 'forward' && value && wet) { wet = false; this.entity.position.x += 1; }
    },
    clearControlStates() { cleared++; for (const key of Object.keys(controls)) controls[key] = false; },
    async lookAt() {},
    canDigBlock() { return true; },
    async dig() { vine = false; }
};
assert.equal(keepAfloat(bot), true, 'active navigation must not prevent surfacing');
assert.equal(controls.jump, true);
assert.equal(controls.sneak, false);
const movements = { climbables: new Set([1, 2, 3]), exclusionAreasStep: [] };
configureTerrainMovements(bot, movements);
configureTerrainMovements(bot, movements);
assert.deepEqual([...movements.climbables], [1, 2]);
assert.equal(movements.exclusionAreasStep.length, 2);
assert.equal(movements.liquidCost, 3);
assert.equal(movements.infiniteLiquidDropdownDistance, false);
let result = await recoverTerrain(bot, { swimMs: 100, tickMs: 1 });
assert.equal(result.kind, 'water');
assert.equal(result.success, true);
assert.equal(controls.forward, false);
bot.entity.position = new Vec3(0.5, 1, 0.5);
vine = true;
result = await recoverTerrain(bot);
assert.deepEqual(result, { kind: 'vine', success: true });
vine = true;
bot.dig = async () => {}; // A dig that did not remove the vine is not success.
result = await recoverTerrain(bot);
assert.equal(result.success, false);
bot.dig = async () => { throw new Error('server refused digging'); };
await assert.rejects(recoverTerrain(bot), /server refused/);
assert.equal(controls.jump, false);
avoidStuckLocation(bot);
assert.equal(movements.exclusionAreasStep[1]({ position: bot.entity.position }), 30);
assert.equal(movements.exclusionAreasStep[1]({ position: new Vec3(100, 1, 100) }), 0);
assert.equal(canceled, 4);
assert.ok(cleared >= 8);
// Repeated failed recoveries at one location must not repeat the chat notification.
const chats = [];
const recoveries = [];
let pending;
const agent = {
    bot, isIdle: () => false, openChat: message => chats.push(message),
    self_prompter: { isActive: () => false }, requestInterrupt() {},
    prompter: { getInitModes: () => Object.fromEntries(['self_preservation', 'cowardice', 'self_defense',
        'hunting', 'item_collecting', 'torch_placing', 'elbow_room'].map(name => [name, false])) },
    live_improver: { snapshot: () => ({}), async recordRecovery(result) { recoveries.push(result); } },
    actions: { currentActionLabel: 'action:searchForBlock', runAction(label, func) {
        pending = func().then(() => ({ interrupted: true, message: 'test recovery' }));
        return pending;
    } }
};
initModes(agent);
// Disable every remaining unrelated mode as well, regardless of profile defaults.
for (const name of Object.keys(bot.modes.getJson())) bot.modes.setOn(name, name === 'unstuck');
let now = Date.now();
const realNow = Date.now;
Date.now = () => now;
try {
    await bot.modes.update();
    for (let attempt = 0; attempt < 3; attempt++) {
        now += 16000;
        await bot.modes.update();
        await pending;
        await Promise.resolve();
    }
    assert.equal(recoveries.length, 3);
    assert.ok(recoveries.every(result => result.success === false));
    assert.equal(bot.modes.behavior_log.match(/遇到障碍/g)?.length, 1);
    assert.equal(chats.filter(message => message.includes('遇到障碍')).length <= 1, true);
    assert.equal(chats.filter(message => message.includes('脱困未成功')).length <= 1, true);
    bot.blockAt = () => air;
    agent.actions.currentActionLabel = 'action:smeltItem';
    for (let i = 0; i < 3; i++) { now += 30000; await bot.modes.update(); }
    assert.equal(recoveries.length, 3, 'waiting for smelting must not trigger recovery');
} finally { Date.now = realNow; }
console.log('Water with active paths surfaces; swimming and vine recovery verify success, cancel routes and release controls.');
