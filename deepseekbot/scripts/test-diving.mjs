import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { diveUnderwater, surfaceFromWater, requestedDiveCommand } from '../src/agent/library/diving.js';
import { needsAir, intentionalDive } from '../src/agent/library/dive_state.js';
import { keepAfloat } from '../src/agent/library/terrain_navigation.js';
import { parseCommandMessage } from '../src/agent/commands/index.js';

assert.equal(requestedDiveCommand('潜水'), '!dive(3, 8)');
assert.equal(requestedDiveCommand('下潜3格，最多8秒'), '!dive(3, 8)');
assert.equal(requestedDiveCommand('上浮换气'), '!surface');
assert.equal(requestedDiveCommand('潜水是怎么操作的'), null);
assert.deepEqual(parseCommandMessage('!dive(3, 8)').args, [3, 8]);
assert.deepEqual(parseCommandMessage('!surface').args, []);
function makeBot() {
    const controls = {};
    return { entity: { position: new Vec3(0, 9.5, 0), effects: {} }, isAlive: true,
        health: 20, oxygenLevel: 20, game: { gameMode: 'survival' }, registry: {},
        controlState: controls, pathfinder: { setGoal() {} },
        blockAt(p) { return { name: p.y < 10 ? 'water' : 'air' }; },
        setControlState(name, value) { controls[name] = value; },
        clearControlStates() { for (const name of Object.keys(controls)) controls[name] = false; }
    };
}
async function simulate(bot, action, onTick = () => {}) {
    let ticks = 0;
    const timer = setInterval(() => {
        onTick(++ticks);
        keepAfloat(bot); // Same safety controller that previously prevented all diving.
        bot.entity.position.y += bot.controlState.jump ? 0.1 : -0.1;
    }, 1);
    try { return await action(); } finally { clearInterval(timer); }
}
let bot = makeBot();
let result = await simulate(bot, () => diveUnderwater(bot, 1, 1, { tickMs: 1 }));
assert.equal(result.reached, true);
assert.equal(result.surfaced, true);
assert.equal(result.success, true);
assert.ok(result.depth >= 0.75);
assert.equal(bot._intentionalDive, undefined);
assert.ok(Object.values(bot.controlState).every(value => value === false));

bot = makeBot();
result = await simulate(bot, () => diveUnderwater(bot, 4, 30, { tickMs: 1 }), tick => {
    if (tick === 6) bot.oxygenLevel = 2;
});
assert.match(result.reason, /氧气/);
assert.equal(result.surfaced, true);
assert.equal(result.reached, false);

bot = makeBot();
result = await simulate(bot, () => diveUnderwater(bot, 4, 30, { tickMs: 1 }), tick => {
    if (tick === 6) bot.interrupt_code = true;
});
assert.match(result.reason, /中断/);
assert.equal(bot._intentionalDive, undefined);
assert.ok(Object.values(bot.controlState).every(value => value === false));

bot = makeBot();
bot.entity.position.y = 20;
assert.equal((await diveUnderwater(bot)).success, false);
bot.entity.position.y = 7;
bot._intentionalDive = { startY: 9, health: 20, until: Date.now() - 1, phase: 'descending' };
assert.equal(intentionalDive(bot), false, 'expired sessions must not suppress floating');
assert.equal(keepAfloat(bot), true);
delete bot._intentionalDive;
bot.oxygenLevel = 0;
assert.equal(needsAir(bot), true);
bot.registry.effectsByName = { WaterBreathing: { id: 13 } };
bot.entity.effects[13] = { id: 13 };
assert.equal(needsAir(bot), false);
bot.entity.effects = {};
result = await surfaceFromWater(bot, { timeoutMs: 15, tickMs: 1 });
assert.equal(result.success, false, 'blocked ascent must not claim the bot reached air');
assert.ok(Object.values(bot.controlState).every(value => value === false));
console.log('Intentional diving coexists with floating safety, reaches depth, surfaces for air, honors interruption and cleans controls.');
