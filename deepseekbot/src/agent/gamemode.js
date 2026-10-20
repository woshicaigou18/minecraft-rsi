import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const modes = new Set(['survival', 'creative', 'adventure']);
const preferencePath = path.resolve('results', 'desired-gamemode.json');

export async function rememberedGameMode() {
    try {
        const value = JSON.parse(await readFile(preferencePath, 'utf8')).mode;
        return modes.has(value) ? value : null;
    } catch { return null; }
}

export function requestedGameMode(message) {
    const chinese = String(message).match(/(?:切换|切到|改成|改为|设置为|设为|开始|进入|变成|变为).{0,6}(创造|生存)(?:模式)?/);
    if (chinese) return chinese[1] === '创造' ? 'creative' : 'survival';
    const english = String(message).match(/(?:switch|change|set|go).{0,25}\b(creative|survival|adventure)\b/i);
    return english?.[1]?.toLowerCase() ?? null;
}

export async function setGameMode(agent, mode) {
    if (!modes.has(mode)) return `Unknown game mode: ${mode}`;
    if (agent.bot.game.gameMode !== mode) {
        agent.bot.chat(`/gamemode ${mode}`);
    }
    await agent.actions.stop();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (agent.bot.game.gameMode !== mode) {
        return `游戏模式仍是 ${agent.bot.game.gameMode}。房主请执行 /gamemode ${mode} ${agent.name}。`;
    }
    await mkdir(path.dirname(preferencePath), { recursive: true });
    await writeFile(preferencePath, JSON.stringify({ mode, updated: new Date().toISOString() }) + '\n');
    return `已切换为 ${mode === 'creative' ? '创造' : mode === 'survival' ? '生存' : '冒险'}模式。`;
}
