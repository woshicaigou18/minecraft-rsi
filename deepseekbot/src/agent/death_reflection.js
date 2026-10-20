import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prismarineChat from 'prismarine-chat';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const liveDir = path.join(root, 'results/rrsi/live');
const clean = (value, length = 1000) => String(value ?? '').replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]').slice(0, length);
async function rows(file) {
    try { return (await readFile(file, 'utf8')).split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    }); } catch { return []; }
}

export class DeathReflection {
    constructor(agent, { directory = liveDir, reviewer = null } = {}) {
        this.agent = agent;
        this.directory = directory;
        this.reviewer = reviewer ?? (death => this.runWorker(death));
        this.frames = [];
        this.actions = [];
        this.queue = [];
        this.sequence = 0;
        this.lastDeathId = null;
        this.dead = false;
        this.initializing = true;
        this.processing = false;
        this.closed = false;
        this.persist = Promise.resolve();
        this.capturing = 0;
    }

    get pending() { return this.initializing || this.dead || this.capturing > 0 || this.processing || this.queue.length > 0; }

    async initialize() {
        await mkdir(this.directory, { recursive: true });
        const done = new Set((await rows(path.join(this.directory, 'death_reflections.jsonl'))).map(row => row.death_id));
        for (const death of await rows(path.join(this.directory, 'deaths.jsonl')))
            if (!done.has(death.id) && !this.queue.some(row => row.id === death.id)) this.queue.push(death);
        this.initializing = false;
        this.drain().catch(error => console.warn('Death reflection:', error.message));
    }

    install() {
        const bot = this.agent.bot;
        this.sample(true);
        bot.on('physicsTick', () => this.sample());
        bot.on('health', () => this.sample(true));
        bot.on('death', () => this.capture());
        bot.on('spawn', () => { this.dead = false; this.sample(true); });
        bot.on('messagestr', (message, _, json) => {
            const key = json?.translate ?? json?.json?.translate;
            const subject = json?.with?.[0]?.toString();
            const own = subject === this.agent.name ||
                (String(message).startsWith(this.agent.name + ' ') || String(message) === this.agent.name);
            if (!key?.startsWith('death.') || !own) return;
            this.attachDeathMessage(message, key);
        });
        // The victim's death packet remains useful when public death messages are disabled.
        bot._client?.on('death_combat_event', packet => {
            if (packet.playerId !== bot.entity?.id) return;
            try {
                const message = prismarineChat(bot.registry).fromNotch(packet.message);
                this.attachDeathMessage(message.toString(), message.translate ?? message.json?.translate);
            } catch (error) { console.warn('Could not parse death cause:', error.message); }
        });
        bot.once('end', () => { this.closed = true; this.worker?.kill(); });
        this.ready = this.initialize().catch(error => {
            this.initializing = false;
            console.warn('Death reflection initialization:', error.message);
        });
    }

    attachDeathMessage(message, translation) {
        const evidence = { message: clean(message, 350), translation: translation ?? null };
        this.deathMessage = { ...evidence, time: Date.now() };
        if (this.latest && Date.now() - Date.parse(this.latest.time) < 3000) Object.assign(this.latest, evidence);
    }

    sample(force = false) {
        if (this.dead || (!force && Date.now() - (this.lastSample ?? 0) < 1000)) return;
        this.lastSample = Date.now();
        const bot = this.agent.bot;
        if (!bot.entity?.position) return;
        const p = bot.entity.position;
        const block = offset => { try { return bot.blockAt(p.offset(0, offset, 0))?.name ?? 'unknown'; } catch { return 'unknown'; } };
        const nearby = Object.values(bot.entities ?? {}).filter(entity => entity !== bot.entity && entity.position &&
            entity.position.distanceTo(p) <= 8).slice(0, 8).map(entity => ({ type: entity.name ?? entity.type,
                distance: Math.round(entity.position.distanceTo(p) * 10) / 10 }));
        this.frames.push({ time: new Date().toISOString(), position: { x: p.x, y: p.y, z: p.z },
            dimension: bot.game?.dimension, health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
            water: bot.entity.isInWater, lava: bot.entity.isInLava, on_ground: bot.entity.onGround,
            velocity_y: bot.entity.velocity?.y, feet: block(0), head: block(1), floor: block(-1),
            action: this.agent.actions.currentActionLabel, nearby });
        this.frames = this.frames.slice(-65);
    }

    noteAction(command, args) {
        this.actions.push({ time: new Date().toISOString(), command, args });
        this.actions = this.actions.slice(-8);
    }

    capture() {
        if (this.dead) return;
        this.sample(true);
        this.dead = true;
        this.sequence++;
        const recentMessage = this.deathMessage && Date.now() - this.deathMessage.time < 3000 ? this.deathMessage : {};
        const death = { id: randomUUID(), time: new Date().toISOString(),
            message: recentMessage.message ?? null, translation: recentMessage.translation ?? null,
            active_action: this.agent.actions.currentActionLabel,
            goal: clean(this.agent.self_prompter?.prompt, 300),
            state: this.agent.live_improver.snapshot(), trace: this.frames.map(row => ({ ...row })),
            recent_actions: this.actions.map(row => ({ ...row })) };
        this.latest = death;
        this.lastDeathId = death.id;
        this.capturing++;
        const p = death.state.position;
        if (p) this.agent.memory_bank.rememberPlace('last_death_position', p.x, p.y, p.z);
        // Let the death announcement arrive, then persist before starting the model.
        this.persist = this.persist.then(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            await mkdir(this.directory, { recursive: true });
            death.recent_results = (await rows(path.join(this.directory, 'events.jsonl')))
                .filter(row => row.action && row.time <= death.time).slice(-8)
                .map(row => ({ command: row.command, args: row.args, outcome: clean(row.outcome), failed: row.failed }));
            await appendFile(path.join(this.directory, 'deaths.jsonl'), JSON.stringify(death) + '\n');
            this.queue.push(death);
            if (!this.initializing) this.drain().catch(error => console.warn('Death reflection:', error.message));
        }).catch(error => console.warn('Could not save death evidence:', error.message))
            .finally(() => { this.capturing--; });
        this.frames = [];
        this.actions = [];
    }

    async drain() {
        if (this.processing || this.initializing || this.closed) return;
        this.processing = true;
        try {
            while (this.queue.length && !this.closed) {
                const death = this.queue[0];
                let result;
                try {
                    result = await this.reviewer(death);
                    if (result.status !== 'reflected') throw new Error(result.reason ?? 'No reflection result');
                } catch (error) {
                    if (this.closed) break; // Keep persisted evidence pending for the next process.
                    result = { death_id: death.id, time: new Date().toISOString(), status: 'unavailable',
                        cause: death.message ?? '死因证据不足，暂时无法确认。',
                        next_plan: '先检查复活后的生命、装备与周围环境，再决定路线；不要立即重复致死行动。',
                        reason: clean(error.message, 200), verified: false };
                    await appendFile(path.join(this.directory, 'death_reflections.jsonl'), JSON.stringify(result) + '\n');
                }
                const summary = `死亡反思：${result.cause}；下一步：${result.next_plan}`;
                try {
                    await this.agent.history.add('system', `[Death ${death.id}] ${summary}\n证据与不确定性：${JSON.stringify(result.evidence ?? [])}；决策问题：${result.decision_error ?? '未知'}。这是待验证的反思，不是已经证明有效的规则。复活后先调整计划，不要盲目重复致死行动。`);
                    await this.agent.history.save();
                } catch (error) { console.warn('Could not save death reflection to chat memory:', error.message); }
                console.log(summary);
                if (this.agent.bot.isAlive && !this.agent.shut_up) this.agent.openChat(clean(summary, 300));
                this.queue.shift();
                this.agent.live_improver.tick(true).catch(error => console.warn('Death RRSI:', error.message));
            }
        } finally { this.processing = false; }
    }

    runWorker(death) {
        return new Promise((resolve, reject) => {
            const child = spawn('python', [path.join(root, 'rrsi_integration/death_reflect.py')], {
                cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
            });
            this.worker = child;
            let output = '';
            const timer = setTimeout(() => child.kill(), 50000);
            child.stdout.on('data', data => { output = (output + data).slice(-12000); });
            child.stderr.on('data', () => {});
            child.stdin.on('error', () => {});
            child.stdin.end(JSON.stringify({ death, directory: this.directory }));
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', code => {
                clearTimeout(timer);
                if (this.worker === child) this.worker = null;
                try {
                    const result = JSON.parse(output.trim().split('\n').at(-1));
                    if (code !== 0 || result.status !== 'reflected') throw new Error(result.reason ?? 'Death review worker failed');
                    resolve(result);
                } catch (error) { reject(error); }
            });
        });
    }
}
