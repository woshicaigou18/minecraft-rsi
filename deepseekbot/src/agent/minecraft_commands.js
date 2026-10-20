// Use the connected player's server permissions for every vanilla/mod/plugin command.
// There is deliberately no command-name allowlist here.
const queues = new WeakMap();

export function requestedMinecraftCommand(message) {
    const text = String(message).trim();
    const explicit = text.match(/^(?:(?:请)?(?:执行|运行|使用)(?:一下)?(?:我的世界|Minecraft)?(?:指令|命令)?\s*[:：]?\s*)(\/[^\r\n]+)$/i);
    if (explicit) return explicit[1];
    if (!/死亡不掉落|keepInventory/i.test(text)) return null;
    if (/(?:是什么|什么意思|怎么用|如何使用|解释|介绍|不要|别执行|别改)/.test(text)) return null;
    if (/(?:关闭|关掉|禁用|取消)/.test(text)) return '/gamerule keepInventory false';
    if (/(?:开启|打开|启用|设置|设为|帮我开|帮我打开)/.test(text)) return '/gamerule keepInventory true';
    if (/(?:查看|查询|是否|有没有|开了吗|开了没)/.test(text)) return '/gamerule keepInventory';
    return null;
}

export function normalizeMinecraftCommand(value) {
    if (typeof value !== 'string') throw new Error('Minecraft 指令必须是字符串。');
    const text = value.trim().replace(/^\//, '');
    if (!text || /^[\s/]/.test(text) || /[\x00-\x1f\x7f]/.test(text))
        throw new Error('请提供一条完整的 Minecraft 指令，不要包含换行。');
    if (text.length > 32767) throw new Error('Minecraft 指令超过 32767 字符。');
    return '/' + text;
}

function sendCommand(bot, command, feedbackMs) {
    return new Promise(resolve => {
        const responses = [];
        let timer;
        const finish = (reason) => {
            clearTimeout(timer);
            bot.removeListener('message', onMessage);
            bot.removeListener('end', onEnd);
            resolve(reason ?? (responses.length
                ? `已发送 ${command}\n服务器反馈（请据此判断执行结果）：\n${responses.join('\n')}`
                : `已发送 ${command}；未收到服务器反馈，不能确认是否成功（服务器可能关闭了指令反馈）。`));
        };
        const onMessage = (message, position, sender) => {
            if (position === 'chat' || position === 'game_info' || sender) return;
            const text = String(message).trim();
            if (text && responses.length < 12) responses.push(text.slice(0, 1500));
        };
        const onEnd = () => finish(`发送 ${command} 时连接断开，无法确认执行结果。`);
        bot.on('message', onMessage);
        bot.once('end', onEnd);
        timer = setTimeout(finish, feedbackMs);
        try { bot.chat(command); }
        catch (error) { finish(`指令发送失败：${error.message}`); }
    });
}

export async function executeMinecraftCommand(agent, value, { feedbackMs = 1500 } = {}) {
    let command;
    try { command = normalizeMinecraftCommand(value); }
    catch (error) { return error.message; }
    const bot = agent.bot;
    const previous = queues.get(bot) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => sendCommand(bot, command, feedbackMs));
    queues.set(bot, pending);
    try { return await pending; }
    finally { if (queues.get(bot) === pending) queues.delete(bot); }
}
