import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reflectionDue } from '../src/agent/live_improver.js';
import { learnedGuidance } from '../src/models/live_guidance.js';

const events = Array.from({ length: 6 }, (_, i) => ({ time: `2026-01-01T00:00:0${i}Z`,
    action: true, command: '!craftRecipe', tokens: 100, outcome: 'Successfully crafted stick.' }));
assert.equal(reflectionDue(events), true);
assert.equal(reflectionDue(events, '2026-01-01T00:00:05Z'), false);
assert.equal(reflectionDue(events.map(row => ({ ...row, action: false }))), false);
assert.equal(reflectionDue(events.slice(0, 2).map(row => ({ ...row, failed: true }))), true);
assert.equal(reflectionDue([{ time: '2026-01-01T00:00:01Z', type: 'death_reflection' }]), true);

const directory = await mkdtemp(path.join(os.tmpdir(), 'rrsi-prompt-'));
try {
    await writeFile(path.join(directory, 'active_guidance.json'), JSON.stringify({ rules: [
        { topic: 'safe_mining', scope: 'mining', guidance: 'Old mining strategy.' },
        { topic: 'smelt_batch', scope: 'smelting', guidance: 'Consider parallel furnaces for large batches.' }
    ] }));
    let prompt = learnedGuidance(directory);
    assert.match(prompt, /Old mining strategy/);
    assert.match(prompt, /parallel furnaces/);
    await writeFile(path.join(directory, 'trial.json'), JSON.stringify({
        topic: 'safe_mining', scope: 'mining', guidance: 'Revised mining strategy.'
    }));
    prompt = learnedGuidance(directory, '!collectBlocks("iron_ore", 3)');
    assert.doesNotMatch(prompt, /Old mining strategy/);
    assert.match(prompt, /Revised mining strategy/);
    await writeFile(path.join(directory, 'death_guidance.json'), JSON.stringify({ lessons: [
        { scope: 'navigation', confidence: 'high', lesson: 'Check oxygen before underwater travel.' }
    ] }));
    prompt = learnedGuidance(directory);
    assert.match(prompt, /Unverified lessons from deaths/);
    assert.match(prompt, /Check oxygen/);
    console.log('Ordinary actions trigger reflection; rules accumulate and trial revisions replace their incumbent prompt.');
} finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('rrsi-prompt-'));
    await rm(directory, { recursive: true, force: true });
}
