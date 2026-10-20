import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCatalog, revertLastExtension } from './runtime_extensions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const liveDir = path.join(root, 'results', 'rrsi', 'live');
const files = Object.fromEntries(['events.jsonl', 'proposals.jsonl', 'history.jsonl',
    'trial.json', 'active_guidance.json', 'decisions.jsonl', 'feedback.jsonl'].map(name =>
    [name.split('.')[0], path.join(liveDir, name)]));
const proposeScript = path.join(root, 'rrsi_integration', 'live_propose.py');
const selectScript = path.join(root, 'rrsi_integration', 'live_select.py');
const suggestionScript = path.join(root, 'rrsi_integration', 'chat_suggestion.py');
const COOLDOWN_MS = 2 * 60 * 1000;
const redact = (value, length) => String(value ?? '')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]').slice(0, length);

async function readJson(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch { return null; }
}

export function looksLikeSuggestion(message) {
    const value = String(message ?? '').trim();
    return value.length >= 8 && value.length <= 350 &&
        /(?:建议|以后|下次|每次|今后|当.{1,50}(?:时|时候)|如果.{1,50}(?:时|就)|遇到.{1,50}时|你(?:可以|应该|最好|不妨).{0,50}试试)/.test(value);
}

export function reflectionDue(events, lastEvidenceTime = '') {
    if (events.some(event => event.type === 'death_reflection' && event.time > lastEvidenceTime)) return true;
    const fresh = events.filter(event => event.action && event.time > lastEvidenceTime &&
        Number.isInteger(event.tokens) && event.tokens > 0 && event.outcome);
    return fresh.length >= 6 || fresh.filter(event => event.failed).length >= 2;
}

export class LiveImprover {
    constructor(agent) {
        this.agent = agent;
        this.inFlight = false;
        this.worker = null;
        this.failedSinceProposal = 0;
        this.lastProposalTime = 0;
        this.initialized = false;
        this.suggestionQueue = [];
        this.reviewingSuggestion = false;
        this.lastTick = 0;
        this.lastEvidenceTime = '';
    }

    async initialize() {
        if (this.initialized) return;
        await mkdir(liveDir, { recursive: true });
        try {
            const lines = (await readFile(files.proposals, 'utf8')).trim().split('\n');
            this.lastProposalTime = Date.parse(JSON.parse(lines.at(-1)).time) || 0;
        } catch { /* No earlier proposal. */ }
        this.lastEvidenceTime = (await readJson(path.join(liveDir, 'scheduler.json')))?.last_evidence_time ?? '';
        this.initialized = true;
    }

    snapshot() {
        const bot = this.agent.bot;
        const inventory = {};
        for (const item of bot?.inventory?.items() ?? [])
            inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
        return { position: bot?.entity?.position ? { x: bot.entity.position.x,
            y: bot.entity.position.y, z: bot.entity.position.z } : null,
            health: bot?.health, game_mode: bot?.game?.gameMode, inventory };
    }

    async currentTrialRound() {
        const trial = await readJson(files.trial);
        // Executable trials are attributed by the implementation actually dispatched.
        return trial?.component === 'prompt' ? trial.round : null;
    }

    async recordRecovery(result, before) {
        await this.initialize();
        await appendFile(files.events, JSON.stringify({ time: new Date().toISOString(),
            type: 'terrain_recovery', command: '!terrainRecovery', action: false,
            outcome: `${result.kind}: ${result.success ? 'escaped' : 'escape failed'}`,
            failed: !result.success, tokens: null, before, after: this.snapshot(), result
        }) + '\n');
    }

    async tick(force = false) {
        if (!force && Date.now() - this.lastTick < 20000) return;
        this.lastTick = Date.now();
        await this.initialize();
        if (this.inFlight) return;
        const pending = (await readJson(path.join(liveDir, 'probation_skills.json')))?.artifacts ?? [];
        if (pending.length) {
            const quarantine = (await readJson(path.join(liveDir, 'extension_quarantine.json')))?.ids ?? [];
            let executions = [];
            try { executions = (await readFile(path.join(liveDir, 'extension_executions.jsonl'), 'utf8')).trim().split('\n').flatMap(line => {
                try { return [JSON.parse(line)]; } catch { return []; }
            }); } catch { /* No new skill executions yet. */ }
            if (pending.some(skill => quarantine.includes(skill.id) || executions.filter(row => row.artifact_id === skill.id &&
                row.artifact_variant === 'probation' && typeof row.native_verified === 'boolean' &&
                (!row.interrupted || row.worker_fault || row.death)).length >= 4)) {
                this.inFlight = true;
                this.runWorker(selectScript, ['--pending-skills', liveDir], 'new_skill_selection');
                return;
            }
        }
        if (await readJson(files.trial)) { this.runSelection(); return; }
        if (Date.now() - this.lastProposalTime < COOLDOWN_MS) return;
        let events = [];
        try {
            events = (await readFile(files.events, 'utf8')).trim().split('\n').flatMap(line => {
                try { return [JSON.parse(line)]; } catch { return []; }
            });
        } catch { return; }
        if (!this.inFlight && reflectionDue(events, this.lastEvidenceTime))
            this.startProposal();
    }

    tokenTotal() {
        const prompter = this.agent.prompter;
        const chat = prompter?.chat_model;
        const code = prompter?.code_model;
        return (chat?.total_tokens || 0) + (code !== chat ? code?.total_tokens || 0 : 0);
    }

    async observe({ command, request, outcome, source, action, tokens, duration_ms, before, after, trial_round, args, death_id,
        artifact_id, artifact_variant, artifact_component, artifact_target, artifact_round, artifact_args, artifact_scope, native_verified }) {
        if (!command) return;
        const invocation = command;
        if (command === '!runSkill' && artifact_target) { command = artifact_target; args = artifact_args; }
        await this.initialize();
        const fullResult = String(outcome ?? '');
        let result = fullResult.startsWith('Agent wrote this code:') ? fullResult.split('Code Output:').at(-1) : fullResult;
        if (death_id) result += '\nAction failed: bot died during this action.';
        let failed = /failed|exception|error:|not allowed|cannot|can't|could not|couldn't|don't have|do not have|timed?\s*out|timeout|not enough|no fuel|no .*nearby|no .*found|不足|失败|无法|未达到|未能|没有进展/i.test(result)
            || (command === '!newAction' && !fullResult.startsWith('Agent wrote this code:'));
        if (!death_id && /You have reached|Successfully (?:crafted|smelted)/i.test(result)) failed = false;
        const event = { time: new Date().toISOString(), command, action: Boolean(action), source,
            request: redact(request, 350), outcome: redact(result, 1200), failed,
            tokens: tokens > 0 ? tokens : null, duration_ms,
            before, after, trial_round: artifact_variant === 'trial' ? artifact_round : trial_round,
            args, death_id, artifact_id, artifact_variant, artifact_component, artifact_target, artifact_scope, native_verified, invocation };
        await appendFile(files.events, JSON.stringify(event) + '\n');
        if (failed) this.failedSinceProposal++;

        if (await readJson(files.trial)) {
            if (!this.inFlight && action) this.runSelection();
            return;
        }
        await this.tick(true);
    }

    async noteFeedback(message) {
        const value = String(message).trim();
        const negative = /(?:刚才|上一步|你刚才).{0,60}(?:做错|没做好|不对|乱放|失败|错误|错了|挖错|建错)/.test(value);
        const positive = /(?:刚才|上一步|你刚才).{0,60}(?:做对|做得好|成功|建得好)/.test(value);
        if (!negative && !positive) return;
        await this.initialize();
        let events;
        try { events = (await readFile(files.events, 'utf8')).trim().split('\n'); }
        catch { return; }
        const latest = events.reverse().map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).find(event => event?.action === true);
        if (!latest) return;
        if (Date.now() - Date.parse(latest.time) > 10 * 60 * 1000) return;
        await appendFile(files.feedback, JSON.stringify({
            time: new Date().toISOString(), action_time: latest.time,
            failed: negative, message: redact(value, 200)
        }) + '\n');
    }

    considerSuggestion(message, source) {
        if (!looksLikeSuggestion(message)) return false;
        if (this.suggestionQueue.length >= 5) return false;
        this.suggestionQueue.push({ message: String(message).trim(), source });
        this.reviewNextSuggestion();
        return true;
    }

    reviewNextSuggestion() {
        if (this.reviewingSuggestion || this.suggestionQueue.length === 0) return;
        this.reviewingSuggestion = true;
        const { message, source } = this.suggestionQueue.shift();
        const child = spawn('python', [suggestionScript], {
            cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        });
        const payload = {
            message,
            context: {
                game_mode: this.agent.bot?.game?.gameMode,
                current_goal: redact(this.agent.self_prompter?.prompt, 180),
                inventory: this.agent.bot?.inventory?.items()?.slice(0, 24)
                    .map(item => `${item.name}:${item.count}`) ?? []
            },
            guidance_path: path.join(liveDir, 'player_guidance.json'),
            audit_path: path.join(liveDir, 'player_suggestions.jsonl')
        };
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(payload));
        let output = '';
        let errors = '';
        child.stdout.on('data', data => { output = (output + data).slice(-3000); });
        child.stderr.on('data', data => { errors = (errors + data).slice(-1000); });
        const timer = setTimeout(() => child.kill(), 50_000);
        let finished = false;
        const finish = (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            this.reviewingSuggestion = false;
            let reply;
            try {
                const result = JSON.parse(output.trim().split('\n').at(-1));
                if (code !== 0 || result.status === 'error') throw new Error(result.reason);
                if (result.status === 'ignored') {
                    this.agent.handleMessage(source, message).catch(error =>
                        console.warn('Could not handle ordinary chat:', error.message));
                    this.reviewNextSuggestion();
                    return;
                }
                if (result.status === 'accepted')
                    reply = `建议已采纳为可选策略：${redact(result.guidance, 100)}`;
                else if (result.status === 'deferred')
                    reply = `这条建议需要更多条件：${redact(result.reason, 100)}`;
                else
                    reply = `这条建议暂不采纳：${redact(result.reason, 100)}`;
                console.log('Player suggestion review:', result.status, result.topic, result.reason);
                if (this.agent.history) {
                    this.agent.history.add('system', `Player advice review: ${result.status}. ${reply} This is optional advice, not an immediate action order.`)
                        .then(() => this.agent.history.save())
                        .catch(error => console.warn('Could not record advice review:', error.message));
                }
            } catch (error) {
                console.warn('Player suggestion review failed:', error.message || errors);
                reply = '这条建议暂时无法审查，请稍后再说一次。';
            }
            if (this.agent.bot?._client?.state === 'play') this.agent.bot.chat(reply);
            this.reviewNextSuggestion();
        };
        child.on('error', error => { errors = error.message; finish(1); });
        child.on('close', finish);
    }

    async handleChat(message) {
        const value = String(message).trim();
        const learn = value.match(/^(?:学习|编写|创建|新增|写)(?:一个|一项|新的|新)?(?:技能|skill)\s*[:：]?\s*(.{3,300})$/i);
        if (learn) {
            await this.initialize();
            if (this.inFlight) return '正在完成上一轮分析，请稍后再提出新技能需求。';
            this.startProposal(redact(learn[1], 300));
            return '正在设计并编写新 JavaScript 技能，测试和审查通过后会自动注册。';
        }
        if (/^(?:查看|列出)(?:技能改进|工具改进|运行改进|可执行改进|已学技能)/.test(value)) {
            const rows = extensionCatalog();
            return rows.length ? `当前可执行改进 ${rows.length} 项：${rows.map(row => `${row.kind} ${row.name ?? row.id}（${row.runtime_status === 'adopted' ? '已保留' : '试用'}）→ ${row.target}`).join('；')}`
                : '目前没有已启用的可执行改进；也可以说“学习新技能：具体能力”，让 RRSI 编写技能文件并测试。';
        }
        if (/^撤销(?:最近|上次)(?:的)?(?:技能改进|工具改进|运行改进|可执行改进)/.test(value)) {
            if (this.worker) this.worker.kill();
            const trial = await readJson(files.trial);
            if (trial?.artifact) { await rm(files.trial, { force: true }); return '已结束可执行改进试用，后续调用恢复原版本。'; }
            return revertLastExtension() ? '已回退最近一次可执行改进，后续调用使用上一版本。' : '目前没有可撤销的可执行改进。';
        }
        if (/^(?:查看死亡反思|上次怎么死的|上次为什么死|死亡反思)/.test(value)) {
            try {
                const lines = (await readFile(path.join(liveDir, 'death_reflections.jsonl'), 'utf8')).trim().split('\n');
                const latest = JSON.parse(lines.at(-1));
                return `上次死亡反思：${redact(latest.cause, 100)}；下一步：${redact(latest.next_plan, 130)}。${latest.confidence ? `判断把握：${latest.confidence}；经验尚待验证。` : '模型反思暂不可用，已保存死亡现场。'}`;
            } catch { return '还没有完成的死亡反思记录；下次死亡后会自动分析。'; }
        }
        if (/^(?:查看策略|学习成果|改进规则|RRSI规则|rrsi规则)/.test(value)) {
            const active = await readJson(files.active_guidance);
            const rules = active?.rules ?? (active?.guidance ? [active] : []);
            return rules.length ? `已验证 ${rules.length} 条策略：${rules.slice(-3).map(rule => redact(rule.guidance, 62)).join('；')}`
                : '目前还没有通过现场评估的策略；试用中的建议不计入已验证策略。';
        }
        if (/^(?:查看|列出)(?:已采纳的|当前的)?建议/.test(value)) {
            const rows = (await readJson(path.join(liveDir, 'player_guidance.json')))?.suggestions ?? [];
            return rows.length ? `已采纳 ${rows.length} 条建议：${rows.slice(-5).map(row => row.topic).join('、')}`
                : '目前没有已采纳的玩家建议。';
        }
        if (/^(?:撤销|删除|忘记|取消)(?:我)?(?:刚才|最近|最后一条)?(?:的)?建议/.test(value)) {
            const target = path.join(liveDir, 'player_guidance.json');
            const data = await readJson(target);
            if (!data?.suggestions?.length) return '目前没有可撤销的玩家建议。';
            const removed = data.suggestions.pop();
            await writeFile(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
            return `已撤销建议：${removed.topic}。`;
        }
        if (/^(?:撤销|取消|回退|恢复)(?:这次|当前|最近)?(?:改进|优化)/.test(value)) {
            if (this.worker) this.worker.kill();
            await Promise.all([rm(files.trial, { force: true }), rm(files.active_guidance, { force: true }),
                rm(path.join(liveDir, 'active_extensions.json'), { force: true }),
                rm(path.join(liveDir, 'probation_skills.json'), { force: true })]);
            return '已撤销试用、提示策略与可执行改进，后续调用恢复内置实现。';
        }
        if (/^(?:RRSI|rrsi|改进|优化)(?:状态|进度)|^查看(?:改进|优化)(?:状态|进度)/.test(value)) {
            const trial = await readJson(files.trial);
            const active = await readJson(files.active_guidance);
            const rules = active?.rules ?? (active?.guidance ? [active] : []);
            let evaluated = 0;
            try {
                evaluated = (await readFile(files.decisions, 'utf8')).trim().split('\n')
                    .filter(line => { try { return Boolean(JSON.parse(line).decision); } catch { return false; } }).length;
            } catch { /* No measured rounds yet. */ }
            const runtime = (await readJson(path.join(liveDir, 'active_extensions.json')))?.artifacts ?? [];
            const newSkills = (await readJson(path.join(liveDir, 'probation_skills.json')))?.artifacts ?? [];
            const quarantine = (await readJson(path.join(liveDir, 'extension_quarantine.json')))?.ids ?? [];
            const summary = `RRSI 已评估 ${evaluated} 轮，保留 ${rules.length} 条提示策略、${runtime.filter(row => !quarantine.includes(row.id)).length} 项可执行改进；新增试用技能 ${newSkills.filter(row => !quarantine.includes(row.id)).length} 项`;
            if (trial) {
                const progress = await readJson(path.join(liveDir, 'progress.json'));
                const count = progress?.round === trial.round ? progress.count : 0;
                return `${summary}；正在试用 ${trial.component} 第 ${trial.round + 1} 轮，同类动作 ${Math.min(count, 4)}/4。`;
            }
            if (rules.length) return `${summary}；会在每批游戏动作后自动反思并继续试验。`;
            try {
                const line = (await readFile(files.proposals, 'utf8')).trim().split('\n').at(-1);
                const latest = JSON.parse(line);
                if (latest.status === 'proposed')
                    return 'RRSI 已提出建议；需要积累 4 次可评估游戏动作，下一轮才能开始试用。';
            } catch { /* No proposal yet. */ }
            return `${summary}；正在积累下一批行动证据。`;
        }
        if (/^(?:提出|给出|生成|开始|尝试|进行)(?:一个|一条|一次|新的)?(?:改进|优化|RRSI)|^改进(?:一下|自己|你的行为)/i.test(value)) {
            await this.initialize();
            if (this.inFlight) return 'RRSI 正在处理上一轮，请稍等。';
            if (await readJson(files.trial)) return 'RRSI 正在试用一条改进，先完成评估。';
            this.startProposal();
            return 'RRSI 已开始分析最近的游戏动作，完成后会在聊天里告诉你。';
        }
        return null;
    }

    startProposal(skillRequest = null) {
        if (this.inFlight) return;
        this.inFlight = true;
        this.failedSinceProposal = 0;
        this.lastProposalTime = Date.now();
        this.lastEvidenceTime = new Date().toISOString();
        writeFile(path.join(liveDir, 'scheduler.json'), JSON.stringify({
            last_evidence_time: this.lastEvidenceTime
        }) + '\n').catch(error => console.warn('Could not save RRSI scheduler:', error.message));
        this.runWorker(proposeScript, ['--events', files.events, '--proposals', files.proposals,
            '--history', files.history, ...(skillRequest ? ['--skill-request', skillRequest] : [])], 'proposal');
    }

    runSelection() {
        if (this.inFlight) return;
        this.inFlight = true;
        this.runWorker(selectScript, ['--events', files.events, '--trial', files.trial,
            '--active', files.active_guidance, '--decisions', files.decisions], 'selection');
    }

    runWorker(script, args, kind) {
        const child = spawn('python', [script, ...args], {
            cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        });
        this.worker = child;
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', data => { output = (output + data).slice(-4000); });
        child.stderr.on('data', data => { errorOutput = (errorOutput + data).slice(-1000); });
        const timer = setTimeout(() => child.kill(), 240_000);
        let settled = false;
        const finish = async (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.inFlight = false;
            if (this.worker === child) this.worker = null;
            try {
                const result = JSON.parse(output.trim().split('\n').at(-1));
                if (code !== 0 || result.status === 'error') {
                    console.warn(`RRSI ${kind}:`, result.reason || errorOutput);
                    return;
                }
                let message = null;
                if (result.status === 'skill_added')
                    message = `RRSI 已编写并注册新技能 ${result.skill_name}，可调用 ${result.skill_command}；现为试用版本，积累 4 次真实调用后验证保留。`;
                else if (result.status === 'native_skills_evaluated' && result.decisions.length)
                    message = `RRSI 新技能验证完成：保留 ${result.accepted} 项，未通过 ${result.decisions.length - result.accepted} 项。`;
                else if (result.status === 'trial_started')
                    message = `RRSI ${result.component} 改进试用中：${redact(result.summary, 80)}。积累 4 次同类动作后评估。`;
                else if (result.status === 'proposed')
                    message = `RRSI 改进建议（待积累动作数据）：${redact(result.summary, 90)}`;
                else if (result.status === 'selected')
                    message = result.extension_count != null ? `RRSI 已采用 ${result.component} 可执行版本，现有 ${result.extension_count} 项；完成指标 ${result.incumbent_score} → ${result.candidate_score}。`
                        : `RRSI 已保留 ${result.rule_count} 条提示策略；本轮完成指标 ${result.incumbent_score} → ${result.candidate_score}。`;
                else if (result.status === 'reverted')
                    message = 'RRSI 试用未通过，已自动撤销。';
                else if (result.status === 'expired')
                    message = 'RRSI 本轮同类动作数据不足，已结束试用，继续探索其他改进。';
                if (message) {
                    console.log(message);
                    if (this.agent.bot?._client?.state === 'play') this.agent.bot.chat(message);
                }
            } catch { console.warn(`RRSI ${kind} returned no result:`, errorOutput); }
        };
        child.on('error', error => {
            console.warn(`RRSI ${kind} failed:`, error.message);
            finish(1);
        });
        child.on('close', finish);
    }
}
