import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { runAgent, SYSTEM_PROMPT } from './agent-loop.js';
import { ConfigError, readConfig } from './config.js';
import { createModelClient } from './model-client.js';
import { calls, iterations } from './plural.js';
import { createSessionLog, type SessionEvent } from './session-log.js';
import { initTracing, shutdownTracing } from './tracing.js';
import { createTokenProvider } from './yandex-auth.js';

/**
 * Один прогон без интерфейса: запрос берётся из аргументов командной строки, лента событий
 * печатается обычным выводом. Нужен для проверки цикла там, где интерактивный ввод
 * недоступен (сценарии, конвейеры, автоматическая проверка).
 */
async function main(): Promise<void> {
    const prompt = process.argv.slice(2).join(' ').trim();
    if (prompt === '') {
        console.error('Использование: npm run once -- "<запрос агенту>"');
        process.exitCode = 1;
        return;
    }

    let config;
    try {
        config = readConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error('\nКонфигурация неполна:\n');
            for (const problem of error.problems) console.error(`  • ${problem}`);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    initTracing(config.tracing);
    const model = createModelClient(config, createTokenProvider(config.auth));
    const log = createSessionLog(print);

    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ];
    log.append({ type: 'user_message', text: prompt });

    try {
        await runAgent({
            model,
            messages,
            log,
            maxIterations: config.maxIterations,
            toolResultMaxChars: config.toolResultMaxChars,
            captureContent: config.tracing.captureContent,
        });
    } catch (error) {
        console.error(
            `\n[прогон не завершён] ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
    }
}

function branch(batchSize: number, batchIndex: number): { call: string; result: string } {
    if (batchSize === 1) return { call: '  ⏺ ', result: '    ⎿ ' };
    const last = batchIndex === batchSize;
    return { call: last ? '  └ ' : '  ├ ', result: last ? '      ⎿ ' : '  │   ⎿ ' };
}

function print(event: SessionEvent): void {
    switch (event.type) {
        case 'user_message':
            console.log(`\n› ${event.text}`);
            break;
        case 'assistant_note':
            console.log(`\n  ✎ текст модели вместе с вызовами: ${event.text}`);
            break;
        case 'tool_call': {
            if (event.batchSize > 1 && event.batchIndex === 1) {
                console.log(`\n  ⏺ ${event.batchSize} ${calls(event.batchSize)} одним ответом`);
            } else if (event.batchSize === 1) {
                console.log('');
            }
            const glyph = branch(event.batchSize, event.batchIndex).call;
            console.log(`${glyph}${event.name}  ${event.rawArguments}`);
            break;
        }
        case 'tool_result': {
            const glyph = branch(event.batchSize, event.batchIndex).result;
            console.log(
                `${glyph}${event.ok ? '' : 'ошибка: '}${event.content}  ·  ${event.durationMs} мс`,
            );
            break;
        }
        case 'assistant_message':
            console.log(`\n${event.text}`);
            break;
        case 'run_finished':
            console.log(
                `\n  ${event.iterations} ${iterations(event.iterations)} · ` +
                    `${event.toolCalls} ${calls(event.toolCalls)} · ` +
                    `${event.promptTokens}→${event.completionTokens} ток. · ` +
                    `${(event.durationMs / 1000).toFixed(1)} с\n`,
            );
            break;
        case 'run_failed':
            console.log(`\n  ✖ ${event.reason}: ${event.message}\n`);
            break;
    }
}

main()
    .finally(shutdownTracing)
    .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
