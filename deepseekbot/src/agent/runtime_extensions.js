import { readFileSync, mkdirSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNativeSkill, validateNativeSkill, executeNativeSkill, loadNativeSource } from './native_skills.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const extensionDirectory = path.join(root, 'results/rrsi/live');
export const runtimeContract = JSON.parse(readFileSync(path.join(root, 'rrsi_integration/runtime_contract.json'), 'utf8'));
const read = (directory, name, fallback = null) => {
    try { return JSON.parse(readFileSync(path.join(directory, name), 'utf8')); } catch { return fallback; }
};
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const failed = value => typeof value !== 'string' || !value.trim() ||
    /failed|cannot|could not|can't|not enough|do not have|don't have|no .*nearby|no .*found|exception|timed? out|unable to|失败|无法|未达到|未能|没有进展/.test(value.toLowerCase());

export function validateArtifact(artifact) {
    if (!object(artifact) || !['skill', 'client_tool', 'config'].includes(artifact.kind)) fail('Unknown artifact kind');
    if (isNativeSkill(artifact)) return validateNativeSkill(artifact);
    const schema = runtimeContract.commands[artifact.target];
    if (!schema) fail('Unsupported executable target');
    if (artifact.kind === 'config') {
        const entries = Object.entries(artifact.values ?? {});
        if (!entries.length || entries.length > 2) fail('Config requires one or two related settings');
        for (const [key, value] of entries) {
            const spec = runtimeContract.settings[key];
            if (!spec || spec.target !== artifact.target || !Number.isFinite(value) || value < spec.min || value > spec.max)
                fail(`Invalid runtime setting ${key}`);
        }
        return artifact;
    }
    if (artifact.kind === 'skill' && !/^[a-z][a-z0-9_]{2,40}$/.test(artifact.name ?? '')) fail('Invalid skill name');
    function valueType(value) {
        if (typeof value === 'string' && value.length <= 120 && !/[\r\n]/.test(value)) return 'string';
        if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 512) return 'number';
        if (object(value) && Object.keys(value).length === 1) {
            if (Number.isInteger(value.arg) && value.arg >= 0 && value.arg < schema.length) return schema[value.arg];
            if (typeof value.inventory === 'string' && /^[a-z_]+$/.test(value.inventory)) return 'number';
        }
        fail('Invalid step argument/reference');
    }
    function condition(value, depth = 0) {
        if (!object(value) || Object.keys(value).length !== 1 || depth > 3) fail('Invalid condition');
        const [key, data] = Object.entries(value)[0];
        if (['inventory_full', 'in_water', 'last_failed'].includes(key) && typeof data === 'boolean') return;
        if (key === 'health_below' && Number.isFinite(data) && data > 0 && data <= 20) return;
        if (key === 'has_item' && object(data) && /^[a-z_]+$/.test(data.name) && Number.isFinite(data.min) && data.min > 0) return;
        if (key === 'all' && Array.isArray(data) && data.length > 0 && data.length <= 4) { data.forEach(row => condition(row, depth + 1)); return; }
        fail('Unknown condition');
    }
    function steps(rows, allowEmpty) {
        if (!Array.isArray(rows) || rows.length > 8 || (!allowEmpty && !rows.length)) fail('Invalid step count');
        for (const step of rows) {
            const types = runtimeContract.commands[step.command];
            if (!types || !Array.isArray(step.args) || step.args.length !== types.length) fail('Invalid primitive signature');
            step.args.forEach((arg, i) => { if (valueType(arg) !== types[i]) fail('Step argument type mismatch'); });
            if (step.when !== undefined) condition(step.when);
        }
    }
    if (artifact.kind === 'skill') {
        steps(artifact.steps, false);
        if (artifact.steps.length < 2) fail('Identity skill adds no executable behavior');
        const last = artifact.steps.at(-1);
        if (last.command !== artifact.target || last.when !== undefined ||
            last.args.some((arg, i) => !object(arg) || arg.arg !== i)) fail('Skill must finish with the original target and original arguments');
    } else {
        steps(artifact.before ?? [], true);
        steps(artifact.on_failure ?? [], true);
        if (!Number.isInteger(artifact.attempts) || artifact.attempts < 1 || artifact.attempts > 3) fail('Invalid attempt limit');
        if (!(artifact.before?.length || artifact.on_failure?.length || artifact.attempts > 1)) fail('No-op tool adapter');
    }
    return artifact;
}

export function chooseExtension(command, directory = extensionDirectory) {
    const quarantined = new Set(read(directory, 'extension_quarantine.json', { ids: [] }).ids);
    const state = read(directory, 'active_extensions.json', { revision: 0, artifacts: [] });
    const active = [...(state.previous?.artifacts ?? []), ...state.artifacts];
    const probation = read(directory, 'probation_skills.json', { artifacts: [] }).artifacts;
    const trial = read(directory, 'trial.json');
    const candidate = trial?.artifact && trial.preflight?.passed === true && trial.base_extension_revision === state.revision &&
        Date.now() - Date.parse(trial.started) < 8 * 60 * 1000 ? trial.artifact : null;
    const rows = [...active.map(artifact => ({ artifact, variant: 'adopted', round: null })),
        ...probation.filter(artifact => artifact.preflight?.passed && artifact.critic?.verdict === 'accept')
            .map(artifact => ({ artifact, variant: 'probation', round: artifact.round })),
        ...(candidate ? [{ artifact: candidate, variant: 'trial', round: trial.round }] : [])];
    for (const row of rows.reverse()) {
        if (row.artifact.target !== command || !row.artifact.id || quarantined.has(row.artifact.id)) continue;
        try { validateArtifact(row.artifact); return row; } catch { /* Invalid files never replace the base tool. */ }
    }
    return null;
}

export function runtimeValue(key, fallback, bot) {
    const value = bot?._runtimeConfig?.[key];
    const spec = runtimeContract.settings[key];
    return spec && Number.isFinite(value) && value >= spec.min && value <= spec.max ? value : fallback;
}

export async function executeArtifact(artifact, context) {
    validateArtifact(artifact);
    let calls = 0, lastResult = '', lastFailed = false;
    const trace = [];
    function matches(value) {
        if (!value) return true;
        if (value.all) return value.all.every(matches);
        if ('inventory_full' in value) return (context.emptySlots() === 0) === value.inventory_full;
        if ('last_failed' in value) return lastFailed === value.last_failed;
        if ('in_water' in value) return context.inWater() === value.in_water;
        if ('health_below' in value) return context.health() < value.health_below;
        return (context.inventory()[value.has_item.name] ?? 0) >= value.has_item.min;
    }
    const resolve = value => object(value) ? ('arg' in value ? context.args[value.arg] : context.inventory()[value.inventory] ?? 0) : value;
    async function invoke(command, args) {
        if (context.canceled()) throw new Error('Extension interrupted');
        if (++calls > 24) throw new Error('Extension call budget exceeded');
        const result = await context.invoke(command, args);
        lastFailed = failed(result);
        lastResult = result;
        trace.push({ command, args, failed: lastFailed });
        if (context.canceled()) throw new Error('Extension interrupted');
        return !lastFailed;
    }
    async function steps(rows) {
        for (const step of rows ?? []) {
            if (!matches(step.when)) continue;
            if (!await invoke(step.command, step.args.map(resolve))) return false;
        }
        return true;
    }
    if (artifact.kind === 'skill') await steps(artifact.steps);
    else if (artifact.kind === 'client_tool') {
        if (await steps(artifact.before)) {
            for (let attempt = 0; attempt < artifact.attempts; attempt++) {
                if (await invoke(artifact.target, context.args)) break;
                if (attempt + 1 === artifact.attempts || !await steps(artifact.on_failure)) break;
            }
        }
    } else await invoke(artifact.target, context.args);
    return { result: lastResult, success: !lastFailed, calls, trace };
}

export function extensionCatalog(directory = extensionDirectory) {
    const commands = new Set(read(directory, 'active_extensions.json', { artifacts: [] }).artifacts.map(row => row.target));
    for (const skill of read(directory, 'probation_skills.json', { artifacts: [] }).artifacts) commands.add(skill.target);
    const trial = read(directory, 'trial.json');
    if (trial?.artifact) commands.add(trial.artifact.target);
    return [...commands].map(command => chooseExtension(command, directory)).filter(Boolean)
        .map(row => ({ ...row.artifact, runtime_status: row.variant }));
}

export function quarantineExtension(id, reason, directory = extensionDirectory) {
    mkdirSync(directory, { recursive: true });
    const data = read(directory, 'extension_quarantine.json', { ids: [] });
    if (!data.ids.includes(id)) data.ids.push(id);
    const temporary = path.join(directory, 'extension_quarantine.tmp');
    writeFileSync(temporary, JSON.stringify(data));
    renameSync(temporary, path.join(directory, 'extension_quarantine.json'));
    appendFileSync(path.join(directory, 'extension_executions.jsonl'), JSON.stringify({ time: new Date().toISOString(),
        artifact_id: id, status: 'quarantined', reason: String(reason).slice(0, 250) }) + '\n');
}

export async function runExtension(agent, command, args, rawInvoke, { directory = extensionDirectory, onExecution } = {}) {
    const selected = chooseExtension(command, directory);
    const metadata = { artifact_id: selected?.artifact.id ?? null, artifact_variant: selected?.variant ?? 'base',
        artifact_component: selected?.artifact.kind ?? null, artifact_target: command, artifact_args: args,
        artifact_scope: selected?.artifact.scope ?? null,
        artifact_round: selected?.round ?? null };
    onExecution?.(metadata);
    if (!selected) return rawInvoke(command, args);
    const { artifact } = selected;
    if (isNativeSkill(artifact)) metadata.native_verified = false;
    if (!await agent.actions.stop()) return 'Extension interrupted: previous action is still stopping.';
    agent.clearBotLogs();
    const epoch = agent._extensionEpoch ?? 0;
    const pin = artifact.kind === 'config' ? { ...artifact.values } : {};
    const previous = agent.bot._runtimeConfig;
    agent.bot._runtimeConfig = pin;
    const deathSequence = agent.death_reflection?.sequence;
    const started = Date.now();
    let result;
    try {
        if (isNativeSkill(artifact)) {
            const executable = loadNativeSource(artifact, directory);
            const { createNativeHost } = await import('./native_skill_host.js');
            const canceled = () => Boolean(agent.bot.interrupt_code || agent.bot.isAlive === false || (agent._extensionEpoch ?? 0) !== epoch);
            const host = createNativeHost(agent, canceled);
            let failure;
            try {
                const action = await agent.actions.runAction(`action:${artifact.target.slice(1)}`, async () => {
                    try {
                        result = await executeNativeSkill(executable, args, host.rpc, { canceled,
                            onAbort: () => agent.requestInterrupt() });
                        metadata.native_verified = result.success;
                    } catch (error) { failure = error; throw error; }
                });
                if (failure) throw failure;
                if (action.interrupted || !result) throw Error('Extension interrupted');
                if (agent.death_reflection?.sequence !== deathSequence) quarantineExtension(artifact.id, 'Bot died during native skill', directory);
                return result.result;
            } finally { host.close(); }
        }
        result = await executeArtifact(artifact, {
            args, inventory: () => {
                const counts = {};
                for (const item of agent.bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count;
                return counts;
            }, emptySlots: () => agent.bot.inventory.emptySlotCount(),
            inWater: () => Boolean(agent.bot.entity.isInWater), health: () => agent.bot.health,
            canceled: () => Boolean(agent.bot.interrupt_code || agent.bot.isAlive === false || (agent._extensionEpoch ?? 0) !== epoch),
            invoke: rawInvoke
        });
        if (agent.death_reflection?.sequence !== deathSequence)
            quarantineExtension(artifact.id, 'Bot died during artifact execution', directory);
        return result.result;
    } catch (error) {
        metadata.worker_fault = Boolean(error.nativeSkillFault);
        if (agent.death_reflection?.sequence !== deathSequence)
            quarantineExtension(artifact.id, 'Bot died during artifact execution', directory);
        else if (error.nativeSkillFault || ((agent._extensionEpoch ?? 0) === epoch && !agent.bot.interrupt_code))
            quarantineExtension(artifact.id, error.message, directory);
        result = { success: false, error: String(error.message) };
        return `Extension failed: ${error.message}. Execution stopped; the original tool remains available.`;
    } finally {
        if (agent.bot._runtimeConfig === pin) agent.bot._runtimeConfig = previous;
        mkdirSync(directory, { recursive: true });
        appendFileSync(path.join(directory, 'extension_executions.jsonl'), JSON.stringify({
            time: new Date().toISOString(), ...metadata, duration_ms: Date.now() - started,
            args, success: result?.success ?? false, calls: result?.calls, trace: result?.trace, error: result?.error,
            interrupted: (agent._extensionEpoch ?? 0) !== epoch, death: agent.death_reflection?.sequence !== deathSequence
        }) + '\n');
    }
}

export function revertLastExtension(directory = extensionDirectory) {
    const state = read(directory, 'active_extensions.json');
    if (!state?.artifacts?.length) return false;
    const next = { revision: state.revision + 1, artifacts: state.previous?.artifacts ?? [], previous: null };
    const temporary = path.join(directory, 'active_extensions.tmp');
    writeFileSync(temporary, JSON.stringify(next));
    renameSync(temporary, path.join(directory, 'active_extensions.json'));
    return true;
}
