import { appendFile, open, readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverInfo } from '../src/mindcraft/mcserver.js';
import { acquireInstanceLock, instanceRunning } from './instance-lock.mjs';

const botDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const minecraftDir = path.resolve(botDir, '..', '.minecraft');
const resultsDir = path.join(botDir, 'results');
const started = Date.now();
const freshLaunch = process.argv.includes('--fresh');
const timeoutMs = 30 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(resultsDir, { recursive: true });
if (!acquireInstanceLock(path.join(resultsDir, 'pcl-bridge.lock'))) process.exit(0);
if (instanceRunning(path.join(resultsDir, 'pcl-main.lock'))) process.exit(0);
const log = async (message) => {
    await appendFile(path.join(resultsDir, 'pcl-bridge.log'),
        `${new Date().toISOString()} ${message}\n`);
};

let hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
if (!hasKey) {
    try {
        hasKey = Boolean(JSON.parse(await readFile(path.join(botDir, 'keys.json'), 'utf8')).DEEPSEEK_API_KEY);
    } catch { /* The bot will need a key before it starts. */ }
}
if (!hasKey) {
    await log('DEEPSEEK_API_KEY is missing; set it or create keys.json before launching PCL.');
    process.exit(1);
}

async function logFiles() {
    const files = [path.join(minecraftDir, 'logs', 'latest.log')];
    const versionsDir = path.join(minecraftDir, 'versions');
    for (const version of await readdir(versionsDir, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        for (const name of ['latest.log', 'debug.log']) {
            files.push(path.join(versionsDir, version.name, 'logs', name));
        }
    }
    return files;
}

async function lastPort(file) {
    try {
        const info = await stat(file);
        if (freshLaunch && info.mtimeMs < started - 120_000) return null;
        const handle = await open(file, 'r');
        try {
            // Manual starts can happen after the LAN announcement was written.
            // A stale port is ignored unless it answers a Minecraft ping.
            const size = Math.min(info.size, 2 * 1024 * 1024);
            const buffer = Buffer.alloc(size);
            await handle.read(buffer, 0, size, info.size - size);
            const matches = [...buffer.toString('utf8').matchAll(/Started serving on (\d{2,5})/g)];
            if (!matches.length) return null;
            return { port: Number(matches.at(-1)[1]), modified: info.mtimeMs, file };
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

await log('Waiting for a PCL Minecraft world to be opened to LAN.');
while (Date.now() - started < timeoutMs) {
    const candidates = (await Promise.all((await logFiles()).map(lastPort)))
        .filter(Boolean).sort((a, b) => b.modified - a.modified);
    for (const candidate of candidates) {
        let server = null;
        try {
            server = await serverInfo('127.0.0.1', candidate.port, 800, false);
        } catch { /* A stale log or transient server state is retried. */ }
        if (!server) continue;
        if (instanceRunning(path.join(resultsDir, 'pcl-main.lock'))) process.exit(0);
        const output = path.join(resultsDir, 'pcl-bot.log');
        const fd = openSync(output, 'a');
        try {
            const child = spawn(process.execPath, ['main.js'], {
                cwd: botDir,
                env: { ...process.env, MINECRAFT_PORT: String(candidate.port) },
                stdio: ['ignore', fd, fd],
                detached: true,
                windowsHide: true
            });
            child.unref();
            await log(`Started DeepSeek bot for ${candidate.file}, port ${candidate.port}, PID ${child.pid}.`);
            process.exit(0);
        } finally {
            closeSync(fd);
        }
    }
    await sleep(3000);
}
await log('Timed out waiting for an Open to LAN world.');
process.exit(1);
