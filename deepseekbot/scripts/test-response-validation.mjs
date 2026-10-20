import assert from 'node:assert/strict';
import { invalidAssistantReply } from '../src/models/response_validation.js';
import { Prompter } from '../src/models/prompter.js';
assert.ok(invalidAssistantReply('!\n\nSYSTEM: Action output:\nNo response.'));
assert.ok(invalidAssistantReply('SYSTEM: Action output:\nNo response.'));
assert.ok(invalidAssistantReply('!'));
assert.equal(invalidAssistantReply('我正在采集木头。 !collectBlocks("oak_log", 3)'), null);
assert.equal(invalidAssistantReply('!stats'), null);
let calls = 0;
const mock = { agent: { name: 'test' }, profile: { conversing: '' },
    async checkCooldown() {}, liveGuidance: () => '', async replaceStrings(value) { return value; }, async _saveLog() {},
    chat_model: { async sendRequest(messages) {
        calls++;
        if (calls > 1) assert.ok(messages.some(row => row.content.includes('rejected')));
        return calls < 3 ? '!\n\nSYSTEM: Action output:\nNo response.' : '!stats';
    } }
};
assert.equal(await Prompter.prototype.promptConvo.call(mock, []), '!stats');
assert.equal(calls, 3);
console.log('Fabricated system/tool responses are rejected and regenerated instead of reaching game chat.');
