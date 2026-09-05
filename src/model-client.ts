import OpenAI from 'openai';
import type {
    ChatCompletionMessage,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { buildModelUri, type AppConfig } from './config.js';
import type { TokenProvider } from './yandex-auth.js';

export class ModelError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ModelError';
    }
}

export type ModelClient = {
    /** URI модели в форме gpt://<folder>/<model> — показывается в интерфейсе. */
    readonly modelUri: string;
    /** Одно обращение к модели. Возвращает сообщение целиком: текст либо требования вызовов. */
    complete(
        messages: readonly ChatCompletionMessageParam[],
        tools: readonly ChatCompletionTool[],
        signal?: AbortSignal,
    ): Promise<ChatCompletionMessage>;
};

/**
 * Клиент OpenAI-совместимого API Yandex AI Studio.
 *
 * IAM-токен короткоживущий, поэтому он не может быть зашит в конструктор клиента: значение
 * `apiKey` здесь — обязательный для конструктора плейсхолдер, а настоящая авторизация
 * подставляется заголовком на каждый запрос. Это то же решение, что применено в miracle.
 */
export function createModelClient(config: AppConfig, tokens: TokenProvider): ModelClient {
    const modelUri = buildModelUri(config);

    const client = new OpenAI({
        apiKey: 'iam-bearer-per-request',
        baseURL: config.baseUrl,
        ...(config.folderId === '' ? {} : { project: config.folderId }),
    });

    return {
        modelUri,

        async complete(messages, tools, signal): Promise<ChatCompletionMessage> {
            const token = await tokens.getToken();

            let response;
            try {
                response = await client.chat.completions.create(
                    {
                        model: modelUri,
                        messages: messages as ChatCompletionMessageParam[],
                        temperature: config.temperature,
                        ...(tools.length > 0 ? { tools: tools as ChatCompletionTool[] } : {}),
                    },
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        ...(signal === undefined ? {} : { signal }),
                    },
                );
            } catch (cause) {
                if (cause instanceof Error && cause.name === 'AbortError') {
                    throw cause;
                }
                throw new ModelError(describeFailure(cause), { cause });
            }

            const choice = response.choices[0];
            if (choice === undefined) {
                throw new ModelError('Модель вернула ответ без вариантов (choices пуст)');
            }
            return choice.message;
        },
    };
}

/**
 * Разворачивает ошибку клиента в читаемое сообщение. Ответы Yandex на неверную модель или
 * недостаточные права содержательны, но по умолчанию теряются внутри объекта ошибки.
 */
function describeFailure(cause: unknown): string {
    if (cause instanceof OpenAI.APIError) {
        const details =
            typeof cause.error === 'object' && cause.error !== null
                ? JSON.stringify(cause.error)
                : cause.message;
        const hint =
            cause.status === 401 || cause.status === 403
                ? ' Проверьте IAM-токен и роль ai.languageModels.user у сервисного аккаунта.'
                : cause.status === 404
                  ? ' Проверьте YANDEX_MODEL и YANDEX_FOLDER_ID: URI модели должен существовать в каталоге.'
                  : '';
        return `Обращение к модели отклонено: HTTP ${cause.status ?? '—'}. ${details}${hint}`;
    }
    if (cause instanceof Error) {
        // У сетевого отказа сообщение верхнего уровня неинформативно («fetch failed»);
        // код причины (ECONNRESET, ENOTFOUND, UND_ERR_*) находится во вложенной ошибке.
        const inner = cause.cause;
        const detail =
            inner instanceof Error
                ? ` (${(inner as NodeJS.ErrnoException).code ?? inner.name}: ${inner.message})`
                : '';
        return `Обращение к модели не удалось: ${cause.message}${detail}`;
    }
    return `Обращение к модели не удалось: ${String(cause)}`;
}
