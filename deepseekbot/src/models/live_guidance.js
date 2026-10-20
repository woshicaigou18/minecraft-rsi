import { readFileSync } from 'node:fs';
import path from 'node:path';

function read(directory, name) {
    try { return JSON.parse(readFileSync(path.join(directory, name), 'utf8')); }
    catch { return null; }
}

const hints = {
    mining: /mining|collectBlocks|digDown|ore|采矿|挖矿|矿石/i,
    building: /placeHere|build|place|block|建造|搭建|放置|建筑/i,
    crafting: /craft|recipe|合成|工作台|制作/i,
    smelting: /smelt|furnace|烧炼|烧东西|熔炉|冶炼/i,
    navigation: /goTo|follow|moveAway|path|navigate|dive|surface|寻路|前往|移动|跟随|潜水|下潜|上浮/i,
    exploration: /search|explor|find|探索|寻找|搜索/i,
    combat: /attack|combat|fight|mob|战斗|攻击|怪物/i,
    inventory: /equip|inventory|chest|consume|装备|背包|箱子|食物/i,
    custom: /newAction|generated code|自定义|写代码/i
};

export function learnedGuidance(directory, context = '') {
    const active = read(directory, 'active_guidance.json');
    const trial = read(directory, 'trial.json');
    const rules = active?.rules ?? (active?.guidance ? [{ ...active, scope: 'general' }] : []);
    const applicable = rules.filter(rule => typeof rule.guidance === 'string' &&
        rule.guidance.length <= 300 && (!trial?.topic || rule.topic !== trial.topic));
    const general = applicable.filter(rule => !rule.scope || rule.scope === 'general').slice(-2);
    const scoped = applicable.filter(rule => rule.scope && rule.scope !== 'general');
    const relevant = context ? scoped.filter(rule => hints[rule.scope]?.test(context)) : scoped;
    const selected = [...general, ...(relevant.length ? relevant : scoped.slice(-3)).slice(-6)];
    let output = selected.length ? '\nLearned Minecraft strategies from live RRSI trials. Use when applicable; follow the current player request:\n' +
        selected.map(rule => `- [${rule.scope ?? 'general'}] ${rule.guidance}`).join('\n') + '\n' : '';
    if (typeof trial?.guidance === 'string' && trial.guidance.length <= 300)
        output += `\nStrategy under evaluation [${trial.scope ?? 'general'}]: ${trial.guidance}\n`;
    const deaths = read(directory, 'death_guidance.json');
    const lessons = (deaths?.lessons ?? []).filter(row => typeof row.lesson === 'string' && row.lesson.length <= 240).slice(-6);
    if (lessons.length) output += '\nUnverified lessons from deaths (conditional hypotheses, not measured RRSI rules). Consider when applicable and follow the current player request:\n' +
        lessons.map(row => `- [${row.scope}; confidence ${row.confidence}] ${row.lesson}`).join('\n') + '\n';
    if (deaths?.latest && Date.now() - Date.parse(deaths.latest.time) < 30 * 60 * 1000)
        output += `\nRecent death analysis: ${deaths.latest.cause}\nReplan after respawn: ${deaths.latest.next_plan}\n`;
    return output;
}
