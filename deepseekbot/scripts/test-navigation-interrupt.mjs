import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import goto from 'mineflayer-pathfinder/lib/goto.js';
import { Agent } from '../src/agent/agent.js';

// Exercise the installed pathfinder's pending goto, without reaching another node.
const bot = new EventEmitter();
bot.pathfinder = { setGoal(goal) { bot.emit('goal_updated', goal); } };
bot.stopDigging = () => {};
bot.collectBlock = { cancelTask() {} };
bot.pvp = { stop() {} };
const pending = goto(bot, {});
const rejected = assert.rejects(pending, error => error.name === 'GoalChanged');
Agent.prototype.requestInterrupt.call({ bot });
await rejected;
assert.equal(bot.interrupt_code, true);
assert.equal(bot.listenerCount('goal_updated'), 0);
console.log('Interrupt rejects an actual pending pathfinder goto immediately without waiting for the next node.');
