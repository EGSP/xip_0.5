import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { runTurn, SYSTEM_PROMPT } from './agent-loop.js';
import { ConfigError, readConfig } from './config.js';
import { createModelClient } from './model-client.js';
import { calls, steps } from './plural.js';
import { createSessionLog, type SessionEvent } from './session-log.js';
import { initSessionContext } from './session-context.js';
import { initTracing, shutdownTracing } from './tracing.js';
import { createTokenProvider } from './yandex-auth.js';

/**
 * Один ход без интерфейса: запрос берётся из аргументов командной строки, лента событий
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
    const session = initSessionContext({
        sessionId: config.tracing.sessionId,
        userId: config.tracing.userId,
    });
    if (config.tracing.enabled) {
        console.log(`  сессия: ${session.sessionId} · пользователь: ${session.userId}`);
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
            maxSteps: config.maxSteps,
            toolResultMaxChars: config.toolResultMaxChars,
            captureContent: config.tracing.captureContent,
        });
    } catch (error) {
        console.error(
            `\n[ход не завершён] ${error instanceof Error ? error.message : String(error)}`,
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
        case 'assistant_reasoning':
            console.log(`
  ⋯ рассуждение модели (${event.tokens} ток., ${event.text.length} символов):`);
            console.log(`    ${event.text.slice(0, 600)}${event.text.length > 600 ? ' …' : ''}`);
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
        case 'turn_finished':
            console.log(
                `\n  ${event.steps} ${steps(event.steps)} · ` +
                    `${event.toolCalls} ${calls(event.toolCalls)} · ` +
                    `${event.promptTokens}→${event.completionTokens} ток. · ` +
                    `${(event.durationMs / 1000).toFixed(1)} с\n`,
            );
            break;
        case 'turn_failed':
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
