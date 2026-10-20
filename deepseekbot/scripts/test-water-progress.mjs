import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { initModes } from '../src/agent/modes.js';

let water = false, submerged = false, recoveries = 0;
const bot = {
    entity: { position: new Vec3(0, 63, 0), yaw: 0 },
    controlState: { forward: true }, pathfinder: { goal: {} },
    blockAt(p) { return { name: water && (submerged || p.y <= this.entity.position.y) ? 'water' : 'air' }; }
};
const agent = {
    bot, isIdle: () => false, openChat() {},
    self_prompter: { isActive: () => false },
    prompter: { getInitModes: () => ({}) },
    actions: { currentActionLabel: 'action:goToCoordinates', async runAction() {
        recoveries++;
        return { interrupted: true, message: 'test' };
    } }
};
initModes(agent);
for (const name of Object.keys(bot.modes.getJson())) bot.modes.setOn(name, name === 'unstuck');
const realNow = Date.now;
let now = Date.now();
Date.now = () => now;
async function step() { now += 1000; await bot.modes.update(); }
try {
    await bot.modes.update();
    for (let i = 0; i < 7; i++) await step();
    water = true;
    await step();
    assert.equal(recoveries, 0, 'entering water must discard time accumulated on land');
    for (let i = 0; i < 60; i++) { bot.entity.position.x += 0.05; await step(); }
    assert.equal(recoveries, 0, 'slow swimming below two metres per window is normal progress');
    submerged = true;
    bot.controlState = { jump: true };
    for (let i = 0; i < 30; i++) { bot.entity.position.y += 0.1; await step(); }
    assert.equal(recoveries, 0, 'surfacing vertically must count as progress');
    submerged = false;
    for (let i = 0; i < 30; i++) await step();
    assert.equal(recoveries, 0, 'floating at the surface is not an attempted movement stall');
    bot.controlState = {};
    for (let i = 0; i < 30; i++) await step();
    assert.equal(recoveries, 0, 'waiting in water without movement input must not trigger recovery');
    bot.controlState = { forward: true };
    await step();
    for (let i = 0; i < 11; i++) await step();
    assert.equal(recoveries, 0);
    await step();
    await Promise.resolve();
    assert.equal(recoveries, 1, 'continuous attempted movement without progress should still recover');
    console.log('Entering water, slow swimming, surfacing and floating are normal; 12 seconds of attempted movement without progress triggers recovery.');
} finally { Date.now = realNow; }
