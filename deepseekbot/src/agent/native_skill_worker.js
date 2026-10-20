import { parentPort, workerData } from 'node:worker_threads';
import 'ses';

// A separate JS thread keeps generated loops off the Minecraft heartbeat thread.
globalThis.lockdown();
let serial = 0;
const pending = new Map();
const rpc = (method, args = []) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'rpc', id, method, args });
});
parentPort.on('message', message => {
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    if (message.error) promise.reject(Error(message.error));
    else promise.resolve(harden(message.value));
});
const api = harden({
    state: () => rpc('state'),
    now: () => rpc('now'),
    wait: ms => rpc('wait', [ms]),
    log: text => rpc('log', [text]),
    blockAt: (x, y, z) => rpc('blockAt', [x, y, z]),
    findBlocks: (name, range = 16, count = 8) => rpc('findBlocks', [name, range, count]),
    control: (name, value) => rpc('control', [name, value]),
    lookAt: (x, y, z) => rpc('lookAt', [x, y, z]),
    skill: (name, args = []) => rpc('skill', [name, args]),
    command: command => rpc('command', [command]),
    openFurnace: position => rpc('openFurnace', [position]),
    furnace: (handle, operation, ...args) => rpc('furnace', [handle, operation, ...args])
});
try {
    const compartment = new Compartment({ api, args: harden(workerData.args) });
    const run = compartment.evaluate(`(${workerData.source})`);
    const result = await run(api, harden(workerData.args));
    parentPort.postMessage({ type: 'result', result });
} catch (error) {
    parentPort.postMessage({ type: 'error', error: String(error.message ?? error) });
}
