import OpenAI from 'openai';
import { getKey } from '../src/utils/keys.js';

const client = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: getKey('DEEPSEEK_API_KEY'),
    timeout: 15_000,
    maxRetries: 0
});

try {
    const result = await client.chat.completions.create({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Reply OK' }],
        max_tokens: 1
    });
    console.log(`DeepSeek API: OK; model=${result.model}`);
} catch (error) {
    console.error(`DeepSeek API: failed; status=${error.status ?? 'none'}; code=${error.code ?? 'none'}`);
    process.exitCode = 1;
}
