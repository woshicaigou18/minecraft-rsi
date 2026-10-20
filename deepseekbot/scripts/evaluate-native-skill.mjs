import { executeNativeSkill, validateNativeSkill } from '../src/agent/native_skills.js';
import { createNativeFixture } from '../src/agent/native_skill_fixture.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
    const { artifact } = JSON.parse(input);
    validateNativeSkill(artifact);
    const reports = [];
    for (const test of artifact.tests) {
        const fixture = createNativeFixture(test.state);
        try {
            const result = await executeNativeSkill(artifact, test.args, fixture.rpc, { timeoutMs: 2000 });
            const expected = test.expected_data ?? {};
            const dataMatches = Object.entries(expected).every(([key, value]) => JSON.stringify(result.value?.data?.[key]) === JSON.stringify(value));
            reports.push({ name: test.name ?? 'generated case', passed: result.success === test.expect_success && dataMatches,
                independently_verified: result.success, calls: result.calls, reason: result.result,
                expected_success: test.expect_success, actual_success: result.success,
                expected_data: expected, actual_data: result.value?.data ?? null });
        } catch (error) { reports.push({ name: test.name, passed: false, reason: error.message }); }
    }
    let canceled = false;
    try { await executeNativeSkill(artifact, artifact.tests[0].args, createNativeFixture().rpc, { canceled: () => true }); }
    catch (error) { canceled = error.message === 'Extension interrupted'; }
    reports.push({ name: 'host cancellation gate', passed: canceled });
    const passed = reports.every(row => row.passed) && reports.some(row => row.independently_verified);
    process.stdout.write(JSON.stringify({ passed, measurement: 'generated JavaScript executed in isolated worker; host checks outcomes in simulated worlds', reports }));
    if (!passed) process.exitCode = 1;
} catch (error) {
    process.stdout.write(JSON.stringify({ passed: false, reason: error.message })); process.exitCode = 1;
}
