import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { runTurn, SYSTEM_PROMPT } from './agent-loop.js';
import { ConfigError, readConfig } from './config.js';
import { createModelClient } from './model-client.js';
import { createSessionLog, type SessionEvent } from './session-log.js';
import { createTokenProvider } from './yandex-auth.js';

/**
 * Один ход агента без интерфейса: запрос берётся из аргументов командной строки, лента
 * событий печатается обычным выводом. Нужен для проверки цикла там, где интерактивный
 * ввод недоступен (сценарии, конвейеры, автоматическая проверка).
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

    const model = createModelClient(config, createTokenProvider(config.auth));
    const log = createSessionLog(print);

    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ];
    log.append({ type: 'user_message', text: prompt });

    try {
        await runTurn({
            model,
            messages,
            log,
            maxIterations: config.maxIterations,
            toolResultMaxChars: config.toolResultMaxChars,
        });
    } catch (error) {
        console.error(`\n[ход не завершён] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

function print(event: SessionEvent): void {
    switch (event.type) {
        case 'user_message':
            console.log(`\n› ${event.text}`);
            break;
        case 'tool_call':
            console.log(`  ⚙ ${event.name}(${event.rawArguments})`);
            break;
        case 'tool_result':
            console.log(`    → ${event.ok ? '' : '[ошибка] '}${event.content} · ${event.durationMs} мс`);
            break;
        case 'assistant_message':
            console.log(`\n${event.text}\n`);
            break;
        case 'turn_failed':
            console.log(`\n[${event.reason}] ${event.message}\n`);
            break;
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
