export function invalidAssistantReply(value) {
    if (typeof value !== 'string' || !value.trim()) return 'Empty assistant reply';
    if (/^\s*(?:SYSTEM|TOOL|USER|ASSISTANT|系统|工具)\s*[:：]/im.test(value))
        return 'Reply impersonates a conversation role or tool result';
    if (/^\s*!\s*$/m.test(value)) return 'A bare exclamation mark is not a command';
    if (/^\s*(?:Action output\s*:|No response\.?\s*$)/im.test(value))
        return 'Reply fabricates an action result instead of responding';
    return null;
}
