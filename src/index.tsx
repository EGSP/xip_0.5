import { render } from 'ink';
import { ConfigError, readConfig, type AppConfig } from './config.js';
import { createModelClient } from './model-client.js';
import { tools } from './tools.js';
import { App } from './ui/App.js';
import { createTokenProvider } from './yandex-auth.js';

/**
 * Точка входа. Конфигурация читается и проверяется до отрисовки интерфейса: сообщение об
 * ошибке должно попасть в обычный вывод терминала, а не в перерисовываемую область Ink,
 * которую та очищает при завершении.
 */
function main(): void {
    let config: AppConfig;
    try {
        config = readConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            process.stderr.write('\nЗапуск невозможен: конфигурация неполна.\n\n');
            for (const problem of error.problems) {
                process.stderr.write(`  • ${problem}\n`);
            }
            process.stderr.write('\nСкопируйте .env.example в .env и заполните значения.\n\n');
            process.exit(1);
            return;
        }
        throw error;
    }

    const tokens = createTokenProvider(config.auth);
    const model = createModelClient(config, tokens);

    printHeader(config, model.modelUri);

    render(<App model={model} config={config} />);
}

function printHeader(config: AppConfig, modelUri: string): void {
    const authKind =
        config.auth.kind === 'static'
            ? 'готовый IAM-токен'
            : `ключ сервисного аккаунта ${config.auth.key.serviceAccountId}`;

    process.stdout.write(
        [
            '',
            'xip 0.5 — минимальный агентский цикл',
            `  модель:        ${modelUri}`,
            `  API:           ${config.baseUrl}`,
            `  авторизация:   ${authKind}`,
            `  инструменты:   ${tools.map((tool) => tool.name).join(', ')}`,
            `  предел шагов:  ${config.maxIterations}`,
            `  каталог:       ${process.cwd()}`,
            '',
        ].join('\n'),
    );
}

main();
