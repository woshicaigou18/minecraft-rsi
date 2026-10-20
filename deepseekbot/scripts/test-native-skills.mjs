import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { executeNativeSkill, loadNativeSource } from '../src/agent/native_skills.js';
import { createNativeFixture } from '../src/agent/native_skill_fixture.js';
import { executeCommand, getCommand, parseCommandMessage } from '../src/agent/commands/index.js';
import { ActionManager } from '../src/agent/action_manager.js';

const artifact = {
    kind: 'skill', implementation: 'javascript', name: 'water_readiness', target: '!skill_water_readiness',
    description: 'Inspect oxygen and health before a water task and compute a suggested depth.',
    parameters: [], timeout_ms: 5000, scope: 'navigation', round: 2,
    source: `async function run(api, args) {
        const s = await api.state();
        const seconds = Math.max(0, (s.oxygen ?? 0) * 0.75 - 5);
        return {success:true,message:'潜水准备检查完成。',data:{health:s.health,oxygen:s.oxygen,maxDepth:Math.floor(seconds)}};
    }`,
    postcondition: { type: 'state_report', fields: ['health', 'oxygen'] },
    tests: [ { name: 'full air', args: [], state: { oxygen: 20 }, expect_success: true },
        { name: 'low air', args: [], state: { oxygen: 2, health: 8 }, expect_success: true } ],
    preflight: { passed: true }, critic: { verdict: 'accept' }
};
artifact.id = 'artifact-' + createHash('sha256').update(artifact.source).digest('hex').slice(0, 16);
artifact.source_sha256 = createHash('sha256').update(artifact.source).digest('hex');
const result = await executeNativeSkill(artifact, [], createNativeFixture().rpc);
assert.equal(result.success, true);
assert.equal(result.value.data.maxDepth, 10);

const liar = { ...artifact, source: 'async function run(api,args) { await api.state(); return {success:true,message:"done",data:{health:999,oxygen:20}}; }' };
assert.equal((await executeNativeSkill(liar, [], createNativeFixture().rpc)).success, false);
const loop = { ...artifact, source: 'async function run(api,args) { while(true) {} }' };
let beats = 0;
const ticker = setInterval(() => beats++, 5);
try { await assert.rejects(executeNativeSkill(loop, [], createNativeFixture().rpc, { timeoutMs: 250 }), /timed out/); }
finally { clearInterval(ticker); }
assert.ok(beats > 2, 'generated CPU loops must not block the Minecraft thread');
const absent = { ...artifact, source: 'async function run(api,args) { const s=await api.state(); return {success:true,message:"checked",data:{health:s.health,oxygen:s.oxygen,processType:typeof process}}; }' };
assert.equal((await executeNativeSkill(absent, [], createNativeFixture().rpc)).value.data.processType, 'undefined');

const directory = await mkdtemp(path.join(os.tmpdir(), 'native-skills-'));
try {
    await mkdir(path.join(directory, 'skills', artifact.id), { recursive: true });
    const sourcePath = path.join(directory, 'skills', artifact.id, 'skill.js');
    await writeFile(sourcePath, 'export default ' + artifact.source);
    assert.equal(loadNativeSource(artifact, directory).source, artifact.source.trim());
    await writeFile(path.join(directory, 'probation_skills.json'), JSON.stringify({ artifacts: [artifact] }));
    assert.equal(getCommand(artifact.target, directory).native_skill, true);
    assert.deepEqual(parseCommandMessage(artifact.target, directory).args, []);
    const bot = { entity: { position: new Vec3(0, 64, 0) }, health: 20, food: 20, oxygenLevel: 20,
        inventory: { items: () => [], emptySlotCount: () => 5 }, blockAt: () => ({ name: 'air' }),
        pathfinder: { setGoal() {} }, clearControlStates() {}, output: '', emit() {} };
    const agent = { bot, blocked_actions: [], clearBotLogs() { bot.interrupt_code = false; bot.output = ''; },
        requestInterrupt() { this._extensionEpoch = (this._extensionEpoch ?? 0) + 1; bot.interrupt_code = true; } };
    agent.actions = new ActionManager(agent);
    let metadata;
    assert.match(await executeCommand(agent, artifact.target, { directory, onExecution: value => { metadata = value; } }), /检查完成/);
    assert.equal(metadata.native_verified, true);
    assert.equal(metadata.artifact_variant, 'probation');
    assert.equal(agent.actions.executing, false);
    const records = (await readFile(path.join(directory, 'extension_executions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records[0].native_verified, true);
    await writeFile(sourcePath, 'export default async function run(api,args) { return null; }');
    assert.throws(() => loadNativeSource(artifact, directory), /hash mismatch/);
    console.log('New JavaScript skill files register as real commands, execute in a worker, verify real state, retain provenance and stop CPU loops.');
} finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('native-skills-'));
    await rm(directory, { recursive: true, force: true });
}
