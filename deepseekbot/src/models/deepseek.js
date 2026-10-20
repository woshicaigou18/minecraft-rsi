import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import { appendFileSync } from 'fs';

export class DeepSeek {
    static prefix = 'deepseek';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.total_tokens = 0;

        let config = {};

        config.baseURL = url || 'https://api.deepseek.com';
        config.apiKey = getKey('DEEPSEEK_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || "deepseek-chat",
            messages,
            stop: stop_seq,
            ...(this.params || {})
        };

        let res = null;
        try {
            console.log('Awaiting deepseek api response...')
            // console.log('Messages:', messages);
            let completion = await this.openai.chat.completions.create(pack);
            this.total_tokens += completion.usage?.total_tokens || 0;
            if (process.env.DEEPSEEK_USAGE_LOG && completion.usage) {
                try {
                    appendFileSync(process.env.DEEPSEEK_USAGE_LOG, JSON.stringify({
                        time: new Date().toISOString(),
                        model: completion.model || pack.model,
                        prompt_tokens: completion.usage.prompt_tokens || 0,
                        completion_tokens: completion.usage.completion_tokens || 0,
                        total_tokens: completion.usage.total_tokens || 0
                    }) + '\n');
                } catch (logError) {
                    console.warn('Could not write DeepSeek usage log:', logError.message);
                }
            }
            if (completion.choices[0].finish_reason == 'length')
                throw new Error('Context length exceeded'); 
            console.log('Received.')
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Deepseek.');
    }
}



