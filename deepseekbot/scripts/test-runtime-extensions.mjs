import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runExtension, chooseExtension, quarantineExtension, revertLastExtension, runtimeValue } from '../src/agent/runtime_extensions.js';
import { executeCommand, getCommand } from '../src/agent/commands/index.js';
import { WaterProgressTracker } from '../src/agent/library/terrain_navigation.js';
import { SkillLibrary } from '../src/agent/library/skill_library.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-artifacts-'));
const artifact = { id: 'fixture-v1', kind: 'client_tool', target: '!moveAway', attempts: 2,
    before: [], on_failure: [{ command: '!moveAway', args: [1] }] };
const oldPerform = getCommand('!moveAway').perform;
const agent = { actions: { async stop() { return true; } }, clearBotLogs() { this.bot.interrupt_code = false; },
    bot: { entity: {}, inventory: { items: () => [], emptySlotCount: () => 1 }, health: 20 }, blocked_actions: [] };
try {
    await writeFile(path.join(directory, 'active_extensions.json'), JSON.stringify({ revision: 0, artifacts: [] }));
    await writeFile(path.join(directory, 'trial.json'), JSON.stringify({ round: 1, started: new Date().toISOString(),
        artifact, base_extension_revision: 0, preflight: { passed: true } }));
    let calls = [], metadata;
    const result = await runExtension(agent, '!moveAway', [5], async (name, args) => {
        calls.push(args[0]); return calls.length === 1 ? 'Failed: temporary obstruction' : 'Moved away.';
    }, { directory, onExecution: row => { metadata = row; } });
    assert.equal(result, 'Moved away.');
    assert.deepEqual(calls, [5, 1, 5]);
    assert.equal(metadata.artifact_variant, 'trial');
    assert.equal(metadata.artifact_id, artifact.id);
    await rm(path.join(directory, 'trial.json'));
    const skill = { id: 'fixture-skill', kind: 'skill', name: 'prepared_move', target: '!moveAway',
        steps: [{ command: '!moveAway', args: [1] }, { command: '!moveAway', args: [{ arg: 0 }] }] };
    await writeFile(path.join(directory, 'active_extensions.json'), JSON.stringify({ revision: 1, artifacts: [skill], previous: { revision: 0, artifacts: [artifact] } }));
    calls = [];
    getCommand('!moveAway').perform = async (_, distance) => { calls.push(distance); return 'Moved away.'; };
    const invocation = `!runSkill("prepared_move", ${JSON.stringify('[5]')})`;
    await executeCommand(agent, invocation, { directory, onExecution: row => { metadata = row; } });
    assert.deepEqual(calls, [1, 5]);
    assert.equal(metadata.artifact_id, skill.id);
    agent._extensionEpoch = 0;
    calls = [];
    await runExtension(agent, '!moveAway', [5], async (_, args) => {
        calls.push(args[0]); agent._extensionEpoch++; return 'Moved away.';
    }, { directory });
    assert.deepEqual(calls, [1], 'interrupted workflows must not run later steps');
    assert.equal(chooseExtension('!moveAway', directory).artifact.id, skill.id, 'ordinary interruption does not quarantine a version');
    await runExtension(agent, '!moveAway', [5], async () => { throw new Error('broken runtime'); }, { directory });
    assert.equal(chooseExtension('!moveAway', directory).artifact.id, artifact.id, 'broken implementation falls back to the previous version');
    assert.equal(revertLastExtension(directory), true);
    assert.equal(chooseExtension('!moveAway', directory).artifact.id, artifact.id);
    agent.death_reflection = { sequence: 0 };
    await runExtension(agent, '!moveAway', [5], async () => {
        agent.death_reflection.sequence++; agent._extensionEpoch++; return undefined;
    }, { directory });
    assert.equal(chooseExtension('!moveAway', directory), null, 'a death quarantines the version even when it also interrupts execution');
    const config = { id: 'fixture-config', kind: 'config', target: '!searchForBlock', values: { search_slice_ms: 2 } };
    await writeFile(path.join(directory, 'active_extensions.json'), JSON.stringify({ revision: 3, artifacts: [config] }));
    let consumed;
    await runExtension(agent, '!searchForBlock', ['lava', 64], async () => {
        consumed = runtimeValue('search_slice_ms', 4, agent.bot); return 'Found lava.';
    }, { directory });
    assert.equal(consumed, 2);
    assert.equal(agent.bot._runtimeConfig, undefined, 'a per-call configuration must be released after execution');
    // Actual water watchdog consumes a pinned parameter, not merely a prompt hint.
    const waterBot = { entity: { position: { x: 0, y: 0, z: 0, clone() { return { ...this }; } } },
        controlState: { forward: true }, _runtimeConfig: { water_stall_ms: 18000 } };
    const tracker = new WaterProgressTracker();
    tracker.update(waterBot, { water: true }, 'action:goToCoordinates', 0);
    assert.equal(tracker.update(waterBot, { water: true }, 'action:goToCoordinates', 13000), false);
    assert.equal(tracker.update(waterBot, { water: true }, 'action:goToCoordinates', 18000), true);
    assert.equal(runtimeValue('water_stall_ms', 12000, { _runtimeConfig: { water_stall_ms: 0 } }), 12000);
    const library = new SkillLibrary({}, null);
    await library.initSkillLibrary();
    assert.ok(Object.keys(library.skill_docs_embeddings).length > 10, 'fallback retrieval must index actual skill docs');
    assert.match(await library.getRelevantSkillDocs('smelt furnace ore', 5), /smeltItem/);
    const audit = (await readFile(path.join(directory, 'extension_executions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(audit.some(row => row.status === 'quarantined'));
    console.log('Runtime skill/tool versions execute, retain attribution, honor interruption, consume real config and fall back on failure.');
} finally {
    getCommand('!moveAway').perform = oldPerform;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('runtime-artifacts-'));
    await rm(directory, { recursive: true, force: true });
}
