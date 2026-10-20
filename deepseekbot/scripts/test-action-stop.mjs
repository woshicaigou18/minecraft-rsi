import assert from 'node:assert/strict';
import { ActionManager } from '../src/agent/action_manager.js';

let interrupts = 0;
const agent = {
    requestInterrupt: () => { interrupts++; },
    cleanKill: () => { throw new Error('Stopping an action must not kill the bot.'); }
};
const manager = new ActionManager(agent);
manager.executing = true;
manager.currentActionLabel = 'existing-action';
assert.equal(await manager.stop(0), false);
assert.equal(interrupts, 1);
assert.equal(manager.executing, true);
manager.stop = async () => false;
let secondStarted = false;
const result = await manager.runAction('next-action', async () => { secondStarted = true; });
assert.equal(result.success, false);
assert.equal(secondStarted, false);
assert.equal(manager.executing, true);
assert.equal(manager.currentActionLabel, 'existing-action');
console.log('An unresponsive action stays owned and prevents concurrent actions without exiting the bot.');
