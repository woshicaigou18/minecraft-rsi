import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { findNearestLoadedBlock } from '../src/agent/library/block_search.js';

let columns = [{ chunkX: -1, chunkZ: 0, column: { sections: [{ palette: [2] }] } },
    { chunkX: 0, chunkZ: 0, column: { sections: [{ palette: [2] }] } }];
let blocks = new Map([
    ['-1,0,0', { type: 2, metadata: 1, position: new Vec3(-1, 0, 0) }],
    ['2,0,0', { type: 2, metadata: 0, position: new Vec3(2, 0, 0) }]
]);
let reads = 0;
const bot = { entity: { position: new Vec3(0, 0, 0) }, game: { minY: 0 },
    world: { getColumns: () => columns }, registry: { blocksByStateId: { 1: { id: 1 }, 2: { id: 2 } } },
    blockAt(p) { reads++; return blocks.get(`${p.x},${p.y},${p.z}`) ?? { type: 1 }; },
    findBlocks() { throw new Error('blocking scan must not be used'); } };
assert.equal((await findNearestLoadedBlock(bot, 2, 500)).position.x, -1);
assert.equal((await findNearestLoadedBlock(bot, 2, 500, block => block.metadata === 0)).position.x, 2);
assert.equal(await findNearestLoadedBlock(bot, 2, 0.5), null);
columns = [{ chunkX: 0, chunkZ: 0, column: { sections: [{ palette: [1] }] } }];
reads = 0;
assert.equal(await findNearestLoadedBlock(bot, 2, 500), null);
assert.equal(reads, 0, 'absent block types should skip whole palettes');
columns = Array.from({ length: 64 }, (_, i) => ({ chunkX: i % 8, chunkZ: Math.floor(i / 8),
    column: { sections: Array.from({ length: 8 }, () => ({})) } }));
blocks = new Map();
let beats = 0;
const timer = setInterval(() => beats++, 1);
try {
    assert.equal(await findNearestLoadedBlock(bot, 2, 500), null);
    assert.ok(beats > 0, 'heartbeats must run during an exhaustive unsuccessful scan');
    reads = 0;
    setTimeout(() => { bot.interrupt_code = true; }, 1);
    await findNearestLoadedBlock(bot, 2, 500);
    assert.ok(reads < 64 * 8 * 4096, 'scan must honor cancellation before completion');
} finally { clearInterval(timer); }
console.log('Large absent-block searches yield to heartbeats, skip absent palettes, preserve nearest/source matches and cancel promptly.');
