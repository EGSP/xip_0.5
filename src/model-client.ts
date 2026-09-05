import { SpanStatusCode } from '@opentelemetry/api';
import OpenAI from 'openai';
import type {
    ChatCompletionMessage,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { buildModelUri, type AppConfig } from './config.js';
import { withRetry } from './retry.js';
import { chatRequestAttributes, chatResponseAttributes } from './tracing-attributes.js';
import { tracer } from './tracing.js';
import type { TokenProvider } from './yandex-auth.js';

export class ModelError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ModelError';
    }
}

/** Расход токенов на одно обращение. Провайдер возвращает его в поле `usage`. */
export type TokenUsage = { readonly prompt: number; readonly completion: number };

export type ModelReply = {
    readonly message: ChatCompletionMessage;
    readonly usage: TokenUsage;
    /**
     * Текст рассуждения модели. Рассуждающие модели тратят часть выходного бюджета на
     * размышление и возвращают его отдельным полем `reasoning_content`; в `content`
     * попадает только итог. Стандартом OpenAI это поле не описано, но его отдают Yandex
     * AI Studio, DeepSeek и большинство развёртываний Qwen.
     */
    readonly reasoning: string | undefined;
    /**
     * Причина остановки генерации. Значение `length` означает, что модель упёрлась в предел
     * выходных токенов; при этом `content` может остаться пустым, если весь бюджет ушёл
     * на рассуждение.
     */
    readonly finishReason: string | undefined;
};

export type ModelClient = {
    /** URI модели в форме gpt://<folder>/<model> — показывается в интерфейсе. */
    readonly modelUri: string;
    /** Одно обращение к модели: текст либо требования вызовов, плюс расход токенов. */
    complete(
        messages: readonly ChatCompletionMessageParam[],
        tools: readonly ChatCompletionTool[],
        signal?: AbortSignal,
    ): Promise<ModelReply>;
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

        async complete(messages, tools, signal): Promise<ModelReply> {
            // Спан `chat` — одно обращение к модели. Имена атрибутов взяты из семантических
            // соглашений OpenTelemetry для GenAI, поэтому Langfuse и подобные бэкенды
            // распознают их сами, без настройки сопоставления.
            const span = tracer().startSpan(`chat ${config.model}`, {
                attributes: chatRequestAttributes(
                    config.model,
                    modelUri,
                    config.temperature,
                    messages,
                    tools,
                    config.tracing.captureContent,
                ),
            });

            try {
                const reply = await callModel(messages, tools, signal);
                span.setAttributes(
                    chatResponseAttributes(
                        reply.message,
                        reply.usage.prompt,
                        reply.usage.completion,
                        config.tracing.captureContent,
                        config.tracing.captureContent ? reply.reasoning : undefined,
                        reply.finishReason,
                    ),
                );
                span.setStatus({ code: SpanStatusCode.OK });
                return reply;
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error),
                });
                throw error;
            } finally {
                span.end();
            }
        },
    };

    async function callModel(
        messages: readonly ChatCompletionMessageParam[],
        tools: readonly ChatCompletionTool[],
        signal: AbortSignal | undefined,
    ): Promise<ModelReply> {
        const token = await tokens.getToken();

        let response;
        try {
            response = await withRetry(
                () =>
                    client.chat.completions.create(
                        {
                            model: modelUri,
                            messages: messages as ChatCompletionMessageParam[],
                            temperature: config.temperature,
                            // Предел выходных токенов. У рассуждающих моделей размышление
                            // расходуется из того же бюджета, что и ответ, поэтому слишком
                            // низкое значение приводит к пустому ответу.
                            ...(config.maxTokens === undefined
                                ? {}
                                : { max_tokens: config.maxTokens }),
                            ...(tools.length > 0 ? { tools: tools as ChatCompletionTool[] } : {}),
                        },
                        {
                            headers: { Authorization: `Bearer ${token}` },
                            ...(signal === undefined ? {} : { signal }),
                        },
                    ),
                signal === undefined ? {} : { signal },
            );
        } catch (cause) {
            if (
                cause instanceof Error &&
                (cause.name === 'AbortError' || cause.name === 'APIUserAbortError')
            ) {
                throw cause;
            }
            throw new ModelError(describeFailure(cause), { cause });
        }

        const choice = response.choices[0];
        if (choice === undefined) {
            throw new ModelError('Модель вернула ответ без вариантов (choices пуст)');
        }

        // Поле `reasoning_content` не описано типами SDK: стандартом OpenAI оно не
        // предусмотрено, но его возвращают Yandex AI Studio, DeepSeek и развёртывания Qwen.
        const reasoning = (choice.message as { reasoning_content?: unknown }).reasoning_content;

        return {
            message: choice.message,
            usage: {
                prompt: response.usage?.prompt_tokens ?? 0,
                completion: response.usage?.completion_tokens ?? 0,
            },
            reasoning: typeof reasoning === 'string' && reasoning !== '' ? reasoning : undefined,
            finishReason: choice.finish_reason ?? undefined,
        };
    }
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
