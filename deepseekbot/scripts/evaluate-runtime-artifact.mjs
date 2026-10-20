// Isolated semantic regression fixtures. These are simulations, not Minecraft benchmarks.
import { executeArtifact, validateArtifact, runtimeContract, runtimeValue } from '../src/agent/runtime_extensions.js';

let input = '';
for await (const data of process.stdin) input += data;
try {
    const { artifact } = JSON.parse(input);
    validateArtifact(artifact);
    const schema = runtimeContract.commands[artifact.target];
    const argumentsFor = {
        '!collectBlocks': ['iron_ore', 3], '!discard': ['diorite', 8], '!consume': ['beef'],
        '!equip': ['diamond_pickaxe'], '!craftRecipe': ['crafting_table', 1], '!smeltItem': ['raw_iron', 3],
        '!placeHere': ['furnace'], '!goToCoordinates': [10, 64, 12, 2], '!moveAway': [3],
        '!searchForBlock': ['lava', 64], '!dive': [3, 8], '!surface': [], '!digDown': [3], '!goToSurface': []
    };
    const reports = [];
    for (const scenario of ['normal', 'full_inventory', 'full_stack', 'missing_tool', 'obstruction', 'unrecoverable', 'canceled']) {
        function world() {
            let inventory = { diorite: 8, cobblestone: 8, beef: 2, diamond_pickaxe: 1, raw_iron: 3, oak_log: 2 };
            if (scenario === 'full_stack') inventory.diorite = 64;
            let empty = ['full_inventory', 'full_stack'].includes(scenario) ? 0 : 4;
            let equipped = scenario !== 'missing_tool';
            let obstruction = scenario === 'obstruction';
            let calls = 0;
            const context = {
                args: argumentsFor[artifact.target], inventory: () => inventory, emptySlots: () => empty,
                inWater: () => false, health: () => 20, canceled: () => scenario === 'canceled',
                async invoke(command, args) {
                    calls++;
                    const types = runtimeContract.commands[command];
                    if (!types || args.length !== types.length || args.some((arg, i) => typeof arg !== types[i])) throw new Error('Bad primitive arguments');
                    if (scenario === 'unrecoverable' && command === artifact.target) return 'Failed: required resources are unavailable.';
                    if (command === '!discard') {
                        if (args[1] <= 0 || args[1] > (inventory[args[0]] ?? 0)) return 'Failed: invalid discard amount.';
                        inventory[args[0]] -= args[1]; empty++; return 'Discarded items.';
                    }
                    if (command === '!moveAway') { obstruction = false; return 'Moved away.'; }
                    if (command === '!equip') { equipped = Boolean(inventory[args[0]]); return equipped ? 'Equipped item.' : 'Failed: item not available.'; }
                    if (command === '!digDown' && !equipped) return 'Failed: correct tool is not equipped.';
                    if (command === '!collectBlocks') {
                        if (!equipped) return 'Failed: correct tool is not equipped.';
                        if (!empty) return 'Failed: inventory is full.';
                        inventory[args[0]] = (inventory[args[0]] ?? 0) + args[1];
                    }
                    if (command === '!placeHere' && obstruction) return 'Failed: placement is obstructed.';
                    return 'Successfully completed the requested action.';
                }
            };
            return { context, count: () => calls };
        }
        const baseline = world(), candidate = world();
        let control, result;
        if (scenario === 'canceled') {
            let rejected = false;
            try { await executeArtifact(artifact, candidate.context); } catch { rejected = true; }
            reports.push({ scenario, passed: rejected && candidate.count() === 0 });
            continue;
        }
        control = await baseline.context.invoke(artifact.target, baseline.context.args);
        result = await executeArtifact(artifact, candidate.context);
        const baselineSuccess = !control.startsWith('Failed');
        const targetCalled = result.trace.some(step => step.command === artifact.target &&
            JSON.stringify(step.args) === JSON.stringify(candidate.context.args));
        const passed = (!baselineSuccess || result.success) && targetCalled &&
            (scenario !== 'unrecoverable' || !result.success) && result.calls <= 24 &&
            candidate.context.inventory().diamond_pickaxe >= baseline.context.inventory().diamond_pickaxe;
        reports.push({ scenario, passed, baseline_success: baselineSuccess,
            candidate_success: result.success, baseline_calls: baseline.count(), candidate_calls: candidate.count() });
    }
    // Verify parameter artifacts are consumed by the common runtime accessor.
    if (artifact.kind === 'config') {
        for (const [key, value] of Object.entries(artifact.values))
            reports.push({ scenario: `setting:${key}`, passed: runtimeValue(key, -1, { _runtimeConfig: artifact.values }) === value });
    }
    const effectObserved = artifact.kind === 'config' || reports.some(row => row.candidate_calls !== undefined && row.candidate_calls !== row.baseline_calls);
    const passed = reports.every(row => row.passed) && effectObserved;
    if (!effectObserved) reports.push({ scenario: 'executable_effect', passed: false, reason: 'No changed execution path observed in fixtures' });
    process.stdout.write(JSON.stringify({ passed, measurement: 'isolated simulated semantic regression fixtures', reports }));
    if (!passed) process.exitCode = 1;
} catch (error) {
    process.stdout.write(JSON.stringify({ passed: false, reason: error.message }));
    process.exitCode = 1;
}
