import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { executeMinecraftCommand, normalizeMinecraftCommand, requestedMinecraftCommand } from '../src/agent/minecraft_commands.js';
import { parseCommandMessage, truncCommandMessage, getCommandDocs } from '../src/agent/commands/index.js';

assert.equal(requestedMinecraftCommand('帮我开启死亡不掉落'), '/gamerule keepInventory true');
assert.equal(requestedMinecraftCommand('关闭死亡不掉落'), '/gamerule keepInventory false');
assert.equal(requestedMinecraftCommand('死亡不掉落开了吗'), '/gamerule keepInventory');
assert.equal(requestedMinecraftCommand('开启死亡不掉落的指令是什么'), null);
assert.equal(requestedMinecraftCommand('不要开启死亡不掉落'), null);
assert.equal(requestedMinecraftCommand('执行 /example:custom @s'), '/example:custom @s');
assert.equal(normalizeMinecraftCommand('gamerule keepInventory true'), '/gamerule keepInventory true');
assert.throws(() => normalizeMinecraftCommand('/time set day\n/kill @s'));
const native = '/execute as @e[type=pig] run data merge entity @s {CustomName:\'{"text":"小猪","color":"gold"}\'}';
const invocation = `!minecraftCommand(${JSON.stringify(native)})`;
assert.deepEqual(parseCommandMessage(invocation), { commandName: '!minecraftCommand', args: [native] });
assert.equal(truncCommandMessage(invocation + ' trailing text'), invocation);
assert.deepEqual(parseCommandMessage('!goToCoordinates(-10, 64, 5, 2)').args, [-10, 64, 5, 2]);
assert.match(getCommandDocs({ blocked_actions: [] }), /!minecraftCommand/);

const bot = new EventEmitter();
const sent = [];
bot.chat = command => {
    sent.push(command);
    bot.emit('message', '<someone> unrelated player chat', 'chat', 'player-uuid');
    bot.emit('message', command.includes('denied') ? 'You do not have permission' : 'keepInventory is currently set to: false', 'system', null);
};
let reply = await executeMinecraftCommand({ bot }, '/gamerule keepInventory', { feedbackMs: 1 });
assert.match(reply, /currently set to: false/);
assert.doesNotMatch(reply, /unrelated/);
reply = await executeMinecraftCommand({ bot }, '/denied', { feedbackMs: 1 });
assert.match(reply, /do not have permission/);
assert.doesNotMatch(reply, /成功/);
bot.chat = command => sent.push(command);
reply = await executeMinecraftCommand({ bot }, native, { feedbackMs: 1 });
assert.equal(sent.at(-1), native);
assert.match(reply, /不能确认是否成功/);
const count = sent.length;
await executeMinecraftCommand({ bot }, '/time set day\n/kill @s');
assert.equal(sent.length, count);
await Promise.all([
    executeMinecraftCommand({ bot }, '/first:plugin command', { feedbackMs: 2 }),
    executeMinecraftCommand({ bot }, '/second:plugin command', { feedbackMs: 2 })
]);
assert.deepEqual(sent.slice(-2), ['/first:plugin command', '/second:plugin command']);
assert.equal(bot.listenerCount('message'), 0);
assert.equal(bot.listenerCount('end'), 0);
bot.chat = () => { throw new Error('socket closed'); };
assert.match(await executeMinecraftCommand({ bot }, '/help', { feedbackMs: 1 }), /发送失败/);
assert.equal(bot.listenerCount('message'), 0);
console.log('Native commands preserve JSON/NBT, accept arbitrary names, serialize feedback, and report denials/unconfirmed results.');
