import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Vec3 } from 'vec3';
import { DeathReflection } from '../src/agent/death_reflection.js';
import registry from 'prismarine-registry';

const directory = await mkdtemp(path.join(os.tmpdir(), 'death-reflect-'));
const bot = new EventEmitter();
Object.assign(bot, { entity: { position: new Vec3(1, 60, 3), velocity: new Vec3(0, 0, 0), isInWater: true },
    game: { dimension: 'overworld' }, health: 4, food: 15, oxygenLevel: 0, isAlive: true,
    blockAt: () => ({ name: 'water' }), entities: {} });
bot.entity.id = 7;
bot._client = new EventEmitter();
bot.registry = registry('1.21.1');
const histories = [], places = [], calls = [];
let ticks = 0;
const agent = { bot, name: 'deepseek', actions: { currentActionLabel: 'action:searchForBlock' },
    self_prompter: { prompt: 'Explore' }, memory_bank: { rememberPlace: (...args) => places.push(args) },
    history: { async add(role, message) { histories.push(message); }, async save() {} }, openChat() {},
    live_improver: { snapshot: () => ({ position: { ...bot.entity.position }, health: bot.health }), async tick() { ticks++; } } };
let release;
const reviewer = async death => {
    calls.push(death);
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    const row = { death_id: death.id, status: 'reflected', cause: '溺水', next_plan: '检查氧气后换路', evidence: ['death.attack.drown'] };
    await appendFile(path.join(directory, 'death_reflections.jsonl'), JSON.stringify(row) + '\n');
    return row;
};
const waitFor = async condition => {
    const deadline = Date.now() + 3000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('test condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
try {
    const reflection = new DeathReflection(agent, { directory, reviewer });
    reflection.install();
    await reflection.ready;
    reflection.noteAction('!searchForBlock', ['water', 32]);
    bot.health = 0;
    bot.emit('health');
    bot.emit('death');
    bot.emit('death'); // duplicate signal in one life
    assert.equal(reflection.sequence, 1);
    bot.emit('messagestr', 'otherplayer drowned', 'system', { translate: 'death.attack.drown' });
    bot._client.emit('death_combat_event', { playerId: 99, message: JSON.stringify({ translate: 'death.attack.lava', with: ['someone'] }) });
    bot._client.emit('death_combat_event', { playerId: 7, message: JSON.stringify({ translate: 'death.attack.drown', with: ['deepseek'] }) });
    bot.entity.position = new Vec3(100, 70, 100);
    bot.health = 20;
    bot.emit('spawn');
    assert.equal(reflection.pending, true, 'respawn must wait for the review, not repeat the fatal action');
    await reflection.persist;
    await waitFor(() => Boolean(release));
    assert.equal(calls[0].state.position.x, 1, 'death coordinates must survive respawn teleport');
    assert.equal(calls[0].trace.at(-1).oxygen, 0);
    assert.equal(calls[0].translation, 'death.attack.drown');
    assert.equal(calls[0].recent_actions[0].command, '!searchForBlock');
    release();
    await waitFor(() => !reflection.pending);
    assert.match(histories[0], /待验证/);
    bot.emit('death'); // another life, another reflection
    bot.emit('spawn');
    await reflection.persist;
    await waitFor(() => !reflection.pending);
    assert.equal(calls.length, 2);
    assert.equal(places.length, 2);
    assert.equal(ticks, 2);
    assert.equal((await readFile(path.join(directory, 'deaths.jsonl'), 'utf8')).trim().split('\n').length, 2);
    const restored = new DeathReflection(agent, { directory, reviewer });
    await restored.initialize();
    assert.equal(calls.length, 2, 'restart must not reflect on completed deaths again');
    // A persisted death interrupted by process exit is reviewed on the next launch.
    await appendFile(path.join(directory, 'deaths.jsonl'), JSON.stringify({ ...calls[0], id: 'pending-on-restart' }) + '\n');
    const resumed = new DeathReflection(agent, { directory, reviewer });
    await resumed.initialize();
    await waitFor(() => !resumed.pending);
    assert.equal(calls.length, 3);
    await appendFile(path.join(directory, 'deaths.jsonl'), JSON.stringify({ id: 'api-failed', time: new Date().toISOString() }) + '\n');
    const failed = new DeathReflection(agent, { directory, reviewer: async () => { throw new Error('API timeout'); } });
    await failed.initialize();
    await waitFor(() => !failed.pending);
    const reports = (await readFile(path.join(directory, 'death_reflections.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(reports.at(-1).status, 'unavailable');
    assert.match(histories.at(-1), /死因证据不足/);
    assert.equal(failed.pending, false, 'API failure must not freeze autonomous play indefinitely');
    console.log('Each life gets one evidence-based death review; respawn waits, coordinates stay frozen and unfinished reviews survive restart.');
} finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('death-reflect-'));
    await rm(directory, { recursive: true, force: true });
}
