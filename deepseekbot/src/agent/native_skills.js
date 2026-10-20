import { Worker } from 'node:worker_threads';
import { parse } from 'espree';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const types = new Set(['string', 'number', 'boolean']);
export const isNativeSkill = artifact => artifact?.kind === 'skill' && artifact.implementation === 'javascript';

export function validateNativeSkill(artifact) {
    if (!isNativeSkill(artifact) || !/^[a-z][a-z0-9_]{2,40}$/.test(artifact.name ?? '') ||
        artifact.target !== '!skill_' + artifact.name) throw Error('Invalid native skill identity');
    if (typeof artifact.description !== 'string' || !artifact.description.trim() || artifact.description.length > 300)
        throw Error('Missing native skill description');
    if (!Array.isArray(artifact.parameters) || artifact.parameters.length > 6 ||
        artifact.parameters.some(p => !/^[a-z][a-z0-9_]*$/.test(p.name ?? '') || !types.has(p.type)))
        throw Error('Invalid native skill parameters');
    if (new Set(artifact.parameters.map(p => p.name)).size !== artifact.parameters.length) throw Error('Duplicate parameters');
    if (typeof artifact.source !== 'string' || artifact.source.length < 30 || artifact.source.length > 16000)
        throw Error('Native skill must contain JavaScript source');
    const ast = parse('(' + artifact.source + ')', { ecmaVersion: 'latest', sourceType: 'script' });
    const fn = ast.body[0]?.expression;
    if (ast.body.length !== 1 || fn?.type !== 'FunctionExpression' || !fn.async || fn.id?.name !== 'run' ||
        fn.params.length !== 2 || fn.params[0]?.name !== 'api' || fn.params[1]?.name !== 'args')
        throw Error('Source must be one async function run(api, args)');
    if (!Array.isArray(artifact.tests) || artifact.tests.length < 2 || artifact.tests.length > 6)
        throw Error('At least two native skill test cases are required');
    if (!artifact.tests.every(test => Array.isArray(test.args) && typeof test.expect_success === 'boolean'))
        throw Error('Invalid native skill tests');
    validatePostcondition(artifact.postcondition, artifact.parameters);
    if (artifact.timeout_ms !== undefined && (!Number.isFinite(artifact.timeout_ms) || artifact.timeout_ms < 1000 || artifact.timeout_ms > 120000))
        throw Error('Invalid native skill timeout');
    return artifact;
}

function validatePostcondition(post, parameters) {
    if (!post || !['inventory_gain', 'position_near', 'surface', 'state_report', 'blocks_present'].includes(post.type))
        throw Error('Native skill requires a supported independently checked postcondition');
    const ref = (value, type) => typeof value === type ||
        (value && Object.keys(value).length === 1 && Number.isInteger(value.arg) && parameters[value.arg]?.type === type);
    if (post.type === 'inventory_gain' && (!ref(post.item, 'string') || !ref(post.amount, 'number'))) throw Error('Invalid inventory postcondition');
    if (post.type === 'blocks_present' && (!ref(post.block, 'string') || !ref(post.positions, 'string'))) throw Error('Invalid block postcondition');
    if (post.type === 'position_near' && (!Array.isArray(post.position) || post.position.length !== 3 ||
        !post.position.every(value => ref(value, 'number')) || !Number.isFinite(post.radius) || post.radius <= 0 || post.radius > 8))
        throw Error('Invalid position postcondition');
    if (post.type === 'state_report' && (!Array.isArray(post.fields) || !post.fields.length ||
        !post.fields.every(field => ['health', 'food', 'oxygen', 'position', 'inventory', 'in_water', 'submerged', 'empty_slots'].includes(field))))
        throw Error('Invalid observation postcondition');
}

export function nativeOutcome(artifact, args, before, after, result, trace) {
    if (!result || result.success !== true || typeof result.message !== 'string') return false;
    const resolve = value => value && typeof value === 'object' ? args[value.arg] : value;
    const post = artifact.postcondition;
    if (post.type === 'inventory_gain') {
        const item = resolve(post.item), amount = resolve(post.amount);
        return typeof item === 'string' && Number.isFinite(amount) && amount > 0 &&
            (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0) >= amount;
    }
    if (post.type === 'surface') return before.submerged === true && after.submerged === false;
    if (post.type === 'blocks_present') return after.checked_blocks?.length > 0 &&
        after.checked_blocks.every(block => block.name === resolve(post.block)) &&
        before.checked_blocks.some(block => block.name !== resolve(post.block));
    if (post.type === 'position_near') {
        const p = post.position.map(resolve);
        const distance = state => Math.hypot(state.position.x - p[0], state.position.y - p[1], state.position.z - p[2]);
        return p.every(Number.isFinite) && distance(before) > post.radius && distance(after) <= post.radius;
    }
    return trace.some(row => row.method === 'state') && post.fields.every(field =>
        result.data && JSON.stringify(result.data[field]) === JSON.stringify((after.last_observation ?? after)[field]));
}

export async function executeNativeSkill(artifact, args, rpc, { timeoutMs = artifact.timeout_ms ?? 30000,
    canceled = () => false, onAbort = () => {} } = {}) {
    validateNativeSkill(artifact);
    if (!Array.isArray(args) || args.length !== artifact.parameters.length ||
        args.some((value, i) => typeof value !== artifact.parameters[i].type ||
            (typeof value === 'number' && !Number.isFinite(value)))) throw Error('Native skill argument type mismatch');
    if (canceled()) throw Error('Extension interrupted');
    async function snapshot() {
        const state = await rpc('state', []);
        if (artifact.postcondition.type === 'blocks_present') {
            const value = artifact.postcondition.positions;
            const positions = JSON.parse(typeof value === 'string' ? value : args[value.arg]);
            if (!Array.isArray(positions) || !positions.length || positions.length > 64 ||
                positions.some(p => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite))) throw Error('Invalid build positions');
            state.checked_blocks = [];
            for (const p of positions) state.checked_blocks.push(await rpc('blockAt', p));
        }
        return state;
    }
    const before = await snapshot();
    const trace = [];
    const worker = new Worker(new URL('./native_skill_worker.js', import.meta.url), {
        workerData: { source: artifact.source, args }, resourceLimits: { maxOldGenerationSizeMb: 64 }
    });
    let queue = Promise.resolve();
    let closed = false;
    let aborted = false;
    let calls = 0;
    let lastObservation;
    const finish = await new Promise((resolve, reject) => {
        const end = (error, value) => {
            if (closed) return;
            closed = true;
            clearTimeout(timer); clearInterval(watchdog);
            worker.terminate();
            if (error) { aborted = true; onAbort(); reject(error); } else resolve(value);
        };
        const timer = setTimeout(() => end(Error('Native skill timed out')), timeoutMs);
        const watchdog = setInterval(() => { if (canceled()) end(Error('Extension interrupted')); }, 30);
        worker.on('error', error => end(error));
        worker.on('exit', code => { if (!closed) end(Error(`Native skill worker exited (${code})`)); });
        worker.on('message', message => {
            if (closed) return;
            if (message.type === 'error') { end(Error(message.error)); return; }
            if (message.type === 'result') { end(null, message.result); return; }
            if (message.type !== 'rpc') return;
            if (++calls > 600) { end(Error('Native skill RPC budget exceeded')); return; }
            queue = queue.then(async () => {
                if (closed || canceled()) return;
                try {
                    const value = await rpc(message.method, message.args);
                    if (message.method === 'state') lastObservation = structuredClone(value);
                    trace.push({ method: message.method, args: message.args });
                    if (!closed) worker.postMessage({ id: message.id, value });
                } catch (error) {
                    if (!closed) worker.postMessage({ id: message.id, error: String(error.message) });
                }
            });
        });
    }).then(value => ({ value }), error => ({ error }));
    // Keep ownership until any in-flight Minecraft operation has actually stopped.
    await queue;
    if (finish.error) {
        finish.error.nativeSkillFault = finish.error.message !== 'Extension interrupted';
        throw finish.error;
    }
    const after = await snapshot();
    after.last_observation = lastObservation;
    const success = nativeOutcome(artifact, args, before, after, finish.value, trace);
    const report = String(finish.value?.message ?? '') + (finish.value?.data ? '\nData: ' + JSON.stringify(finish.value.data).slice(0, 4000) : '');
    return { result: success ? report : 'Failed: native skill postcondition was not satisfied. ' + report,
        success, value: finish.value, before, after, calls, trace, aborted };
}

export function loadNativeSource(artifact, directory) {
    if (!/^artifact-[a-f0-9]{16}$/.test(artifact.id ?? '')) throw Error('Invalid native skill version');
    const source = readFileSync(path.join(directory, 'skills', artifact.id, 'skill.js'), 'utf8').replace(/^export default\s+/, '').trim();
    if (createHash('sha256').update(source).digest('hex') !== artifact.source_sha256) throw Error('Native skill file hash mismatch');
    return { ...artifact, source };
}
