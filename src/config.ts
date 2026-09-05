import { config as loadDotenv } from 'dotenv';

loadDotenv();

/** Базовый адрес OpenAI-совместимого API Yandex AI Studio (Chat Completions). */
const DEFAULT_BASE_URL = 'https://llm.api.cloud.yandex.net/v1';

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 8000;

/**
 * Учётные данные авторизованного ключа сервисного аккаунта. Программа сама подписывает JWT
 * и обменивает его на IAM-токен — так же, как это делает `yc iam create-token`.
 */
export type ServiceAccountKey = {
    readonly keyId: string;
    readonly serviceAccountId: string;
    readonly privateKey: string;
};

/**
 * Способ получения IAM-токена. Готовый токен удобен для первой проверки, ключ сервисного
 * аккаунта — для нормальной работы, поскольку токен живёт около 12 часов и требует обновления.
 */
export type AuthConfig =
    | { readonly kind: 'static'; readonly token: string }
    | { readonly kind: 'serviceAccount'; readonly key: ServiceAccountKey };

/**
 * Настройки трассировки. Экспорт включается заданием адреса коллектора: пока он пуст,
 * телеметрия никуда не отправляется и экспортёр не создаётся вовсе.
 */
export type TracingConfig = {
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly serviceName: string;
    /**
     * Записывать ли в спаны тексты запросов и ответов модели. Для учебного стенда это и есть
     * главная польза трассировки, поэтому по умолчанию включено. В рабочей системе значение
     * должно быть противоположным: иначе пользовательский ввод уходит в коллектор.
     */
    readonly captureContent: boolean;
    /**
     * Идентификатор пользователя для телеметрии. Пусто — берётся имя машины с приставкой `l_`,
     * обозначающей локальный запуск.
     */
    readonly userId: string;
    /**
     * Идентификатор сессии. Пусто — порождается при запуске. Задаётся явно, когда нужно
     * объединить несколько запусков `npm run once` в одну сессию.
     */
    readonly sessionId: string;
};

export type AppConfig = {
    /** Значение YANDEX_MODEL как его задал пользователь (короткое имя или полный URI). */
    readonly model: string;
    /** Идентификатор каталога; пуст, если модель задана полным URI. */
    readonly folderId: string;
    readonly baseUrl: string;
    readonly auth: AuthConfig;
    readonly maxSteps: number;
    readonly temperature: number;
    /** Предел выходных токенов на одно обращение. Не задан — используется значение модели. */
    readonly maxTokens: number | undefined;
    readonly toolResultMaxChars: number;
    readonly tracing: TracingConfig;
};

/**
 * Ошибка конфигурации. Несёт перечень проблем целиком, а не первую из них: при первом запуске
 * незаполненных переменных обычно несколько, и сообщать о них по одной за запуск неудобно.
 */
export class ConfigError extends Error {
    readonly problems: readonly string[];

    constructor(problems: readonly string[]) {
        super(problems.join('\n'));
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

const trimmed = (name: string): string => (process.env[name] ?? '').trim();

/** Экранированные `\n` из .env превращаются в настоящие переносы; сам PEM не меняется. */
const unescapeNewlines = (raw: string): string => raw.replace(/\\n/g, '\n');

function readNumber(name: string, fallback: number, problems: string[]): number {
    const raw = trimmed(name);
    if (raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        problems.push(`${name}: ожидалось число, получено "${raw}"`);
        return fallback;
    }
    return value;
}

/**
 * Читает и проверяет конфигурацию. Бросает {@link ConfigError} со всеми найденными проблемами,
 * поэтому вызывать её нужно до отрисовки интерфейса — сообщение об ошибке должно попасть
 * в обычный вывод терминала, а не в перерисовываемую область Ink.
 */
export function readConfig(): AppConfig {
    const problems: string[] = [];

    const model = trimmed('YANDEX_MODEL');
    if (model === '') {
        problems.push(
            'YANDEX_MODEL не задана. Укажите модель в файле .env, например: YANDEX_MODEL=yandexgpt/latest',
        );
    }

    const folderId = trimmed('YANDEX_FOLDER_ID');
    const modelIsFullUri = model.startsWith('gpt://');
    if (folderId === '' && !modelIsFullUri) {
        problems.push(
            'YANDEX_FOLDER_ID не задан. Он нужен, чтобы собрать URI модели вида gpt://<folder>/<model>. ' +
                'Либо задайте каталог, либо запишите YANDEX_MODEL полным URI.',
        );
    }

    const staticToken = trimmed('YANDEX_IAM_TOKEN');
    const keyId = trimmed('YANDEX_KEY_ID');
    const serviceAccountId = trimmed('YANDEX_SERVICE_ACCOUNT_ID');
    const privateKey = unescapeNewlines(process.env['YANDEX_PRIVATE_KEY'] ?? '').trim();

    let auth: AuthConfig | undefined;
    if (staticToken !== '') {
        auth = { kind: 'static', token: staticToken };
    } else if (keyId !== '' && serviceAccountId !== '' && privateKey !== '') {
        auth = { kind: 'serviceAccount', key: { keyId, serviceAccountId, privateKey } };
    } else {
        const missing = [
            keyId === '' ? 'YANDEX_KEY_ID' : null,
            serviceAccountId === '' ? 'YANDEX_SERVICE_ACCOUNT_ID' : null,
            privateKey === '' ? 'YANDEX_PRIVATE_KEY' : null,
        ].filter((name): name is string => name !== null);
        problems.push(
            'Не настроена аутентификация. Задайте либо YANDEX_IAM_TOKEN (готовый токен из `yc iam create-token`), ' +
                `либо ключ сервисного аккаунта целиком — не хватает: ${missing.join(', ')}.`,
        );
    }

    const maxSteps = readNumber('AGENT_MAX_STEPS', DEFAULT_MAX_STEPS, problems);
    const temperature = readNumber('AGENT_TEMPERATURE', DEFAULT_TEMPERATURE, problems);
    const toolResultMaxChars = readNumber(
        'TOOL_RESULT_MAX_CHARS',
        DEFAULT_TOOL_RESULT_MAX_CHARS,
        problems,
    );

    const maxTokensRaw = trimmed('AGENT_MAX_TOKENS');
    const maxTokens = maxTokensRaw === '' ? undefined : Number(maxTokensRaw);
    if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens < 1)) {
        problems.push(`AGENT_MAX_TOKENS: ожидалось положительное число, получено "${maxTokensRaw}"`);
    }

    if (maxSteps < 1) {
        problems.push('AGENT_MAX_STEPS должен быть не меньше 1');
    }

    if (problems.length > 0 || auth === undefined) {
        throw new ConfigError(problems);
    }

    const baseUrlRaw = trimmed('YANDEX_BASE_URL');
    const otlpEndpoint = trimmed('OTEL_EXPORTER_OTLP_ENDPOINT').replace(/\/+$/, '');
    const serviceNameRaw = trimmed('OTEL_SERVICE_NAME');
    const captureRaw = trimmed('OTEL_CAPTURE_CONTENT').toLowerCase();

    return {
        model,
        folderId,
        baseUrl: baseUrlRaw === '' ? DEFAULT_BASE_URL : baseUrlRaw,
        auth,
        maxSteps,
        temperature,
        maxTokens,
        toolResultMaxChars,
        tracing: {
            enabled: otlpEndpoint !== '',
            endpoint: otlpEndpoint,
            serviceName: serviceNameRaw === '' ? 'xip-0.5' : serviceNameRaw,
            captureContent: captureRaw !== 'false' && captureRaw !== '0',
            userId: trimmed('AGENT_USER_ID'),
            sessionId: trimmed('AGENT_SESSION_ID'),
        },
    };
}

/**
 * Приводит модель к форме `gpt://<folderId>/<model>`, если она задана коротким именем.
 * Полный URI остаётся без изменений.
 */
export function buildModelUri(config: AppConfig): string {
    return config.model.startsWith('gpt://')
        ? config.model
        : `gpt://${config.folderId}/${config.model}`;
}
