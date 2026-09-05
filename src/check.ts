import { ConfigError, readConfig } from './config.js';
import { createModelClient } from './model-client.js';
import { initTracing, shutdownTracing } from './tracing.js';
import { createTokenProvider } from './yandex-auth.js';

/**
 * Проверка настройки без интерфейса: получение IAM-токена и одно обращение к модели без
 * инструментов. Отделена от основной программы намеренно — при отказе видно, на каком из
 * двух шагов он произошёл, а сообщения об ошибках не затираются перерисовкой Ink.
 */
async function main(): Promise<void> {
    let config;
    try {
        config = readConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error('\nКонфигурация неполна:\n');
            for (const problem of error.problems) console.error(`  • ${problem}`);
            console.error('');
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    console.log('\n1. Получение IAM-токена');
    initTracing(config.tracing);
    const tokens = createTokenProvider(config.auth);
    const started = Date.now();
    const token = await tokens.getToken();
    const current = tokens.peek();

    console.log(`   получен за ${Date.now() - started} мс`);
    console.log(`   токен: ${token.slice(0, 12)}…${token.slice(-6)} (${token.length} символов)`);
    if (current !== undefined && Number.isFinite(current.refreshAtMs)) {
        const minutes = Math.round((current.refreshAtMs - Date.now()) / 60000);
        console.log(`   перевыпуск через ~${minutes} мин`);
    } else {
        console.log('   срок жизни неизвестен (задан готовый токен)');
    }

    console.log('\n2. Обращение к модели');
    const model = createModelClient(config, tokens);
    console.log(`   модель: ${model.modelUri}`);

    const answerStarted = Date.now();
    const reply = await model.complete(
        [
            { role: 'system', content: 'Отвечай одним словом по-русски.' },
            { role: 'user', content: 'Скажи слово: готово' },
        ],
        [],
    );
    console.log(`   ответ за ${Date.now() - answerStarted} мс (${reply.usage.prompt}→${reply.usage.completion} ток.): ${JSON.stringify(reply.message.content)}`);
    console.log('\nНастройка работает.\n');
}

main()
    .finally(shutdownTracing)
    .catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
