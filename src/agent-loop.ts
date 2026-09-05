import { SpanStatusCode, type Span } from '@opentelemetry/api';
import type {
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ModelClient } from './model-client.js';
import type { SessionLog } from './session-log.js';
import { toolByName, toolSpecs, tools } from './tools.js';
import { toolCallAttributes, toolResultAttributes } from './tracing-attributes.js';
import { tracer } from './tracing.js';

export const SYSTEM_PROMPT = [
    'Ты — рабочий агент. У тебя есть инструменты; чтобы узнать факт, вызывай инструмент,',
    'а не предполагай.',
    'Не выдумывай данные. Если инструмент вернул ошибку — прочитай её текст и исправь вызов,',
    'а не повторяй тот же самый.',
    'Сначала вызовы инструментов, потом ответ: не пиши выводы в том же сообщении, где',
    'запрашиваешь данные для них.',
    'Отвечай пользователю по-русски и кратко.',
].join(' ');

/**
 * Состояние текущего прогона для живой области интерфейса.
 *
 * Прогон — одно исполнение цикла от сообщения пользователя до итогового ответа.
 * Итерация — один виток внутри прогона: обращение к модели плюс исполнение вызовов,
 * которые оно затребовало.
 */
export type RunProgress =
    | { readonly kind: 'model'; readonly iteration: number; readonly maxIterations: number }
    | {
          readonly kind: 'tool';
          readonly iteration: number;
          readonly maxIterations: number;
          readonly name: string;
          readonly batchIndex: number;
          readonly batchSize: number;
      };

export class IterationLimitError extends Error {
    constructor(limit: number) {
        super(
            `Прогон остановлен: превышен предел в ${limit} итераций. Задача, вероятно, слишком ` +
                'велика для одного прогона, либо модель зациклилась на одном инструменте.',
        );
        this.name = 'IterationLimitError';
    }
}

export type RunAgentParams = {
    readonly model: ModelClient;
    /** Массив сообщений, отправляемый модели. Мутируется: прогон дописывает в него свои записи. */
    readonly messages: ChatCompletionMessageParam[];
    readonly log: SessionLog;
    readonly maxIterations: number;
    readonly toolResultMaxChars: number;
    /** Записывать ли в спаны аргументы и результаты вызовов. */
    readonly captureContent?: boolean;
    readonly onProgress?: (progress: RunProgress) => void;
    readonly signal?: AbortSignal;
};

/**
 * Один прогон агентского цикла.
 *
 * API модели не имеет памяти: каждое обращение отправляет весь массив сообщений заново.
 * Модель ничего не выполняет — она называет имя функции и аргументы, а выполняет программа,
 * кладёт результат в массив и отправляет массив снова. Прогон завершается, когда ответ
 * модели не содержит требований вызова.
 */
export async function runAgent(params: RunAgentParams): Promise<string> {
    // Спан `invoke_agent` — весь прогон целиком; внутри него оказываются спаны обращений
    // к модели и вызовов инструментов. Так в трассировке видно, из чего сложилось время
    // ответа: сколько заняла модель, сколько инструменты.
    // startActiveSpan, а не startSpan: спан помещается в текущий контекст, и вложенные
    // спаны обращений к модели и вызовов инструментов подхватывают его как родителя сами.
    // С обычным startSpan они оказались бы отдельными корнями, и дерево не собралось бы.
    return tracer().startActiveSpan(
        'invoke_agent',
        {
            attributes: {
                'gen_ai.operation.name': 'invoke_agent',
                'openinference.span.kind': 'AGENT',
            },
        },
        async (span) => {
            try {
                const result = await runInSpan(params, span);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
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
    );
}

async function runInSpan(params: RunAgentParams, runSpan: Span): Promise<string> {
    const { model, messages, log, maxIterations, toolResultMaxChars, onProgress, signal } = params;
    const captureContent = params.captureContent ?? false;

    // Запрос пользователя выносится на корневой спан: тогда в списке прогонов видно, о чём
    // был прогон, без раскрытия дерева. Итоговый ответ ставится туда же при завершении.
    if (captureContent) {
        const lastUser = [...messages].reverse().find((message) => message.role === 'user');
        const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
        if (text !== '') {
            runSpan.setAttributes({ 'input.value': text, 'input.mime_type': 'text/plain' });
        }
    }

    const startedAt = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;
    let toolCalls = 0;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        onProgress?.({ kind: 'model', iteration, maxIterations });

        const reply = await model.complete(messages, toolSpecs, signal);
        promptTokens += reply.usage.prompt;
        completionTokens += reply.usage.completion;

        const message = reply.message;

        // (а) Ответ модели добавляется в массив как есть, вместе с идентификаторами вызовов:
        // сообщения с ролью "tool" привязаны к ним, и без них следующий запрос будет отвергнут.
        messages.push(message);

        const calls = message.tool_calls ?? [];
        const text = (message.content ?? '').trim();

        // (б) Вызовов нет — модель ответила текстом, прогон закончен.
        if (calls.length === 0) {
            log.append({ type: 'assistant_message', text });
            log.append({
                type: 'run_finished',
                iterations: iteration,
                toolCalls,
                promptTokens,
                completionTokens,
                durationMs: Date.now() - startedAt,
            });
            if (captureContent && text !== '') {
                runSpan.setAttributes({ 'output.value': text, 'output.mime_type': 'text/plain' });
            }
            runSpan.setAttributes({
                'agent.iterations': iteration,
                'agent.tool_calls': toolCalls,
                'gen_ai.usage.input_tokens': promptTokens,
                'gen_ai.usage.output_tokens': completionTokens,
            });
            return text;
        }

        // Поле content при вызовах необязательно. Если модель всё же что-то написала,
        // это отмечается отдельным событием: так видно, разговаривает ли она между вызовами.
        if (text !== '') {
            log.append({ type: 'assistant_note', iteration, text });
        }

        // (в) Вызовы есть — выполняем каждый. Пропущенный результат сделает следующий запрос
        // невалидным, поэтому цикл проходит по всем вызовам без исключений.
        const batchSize = calls.length;
        for (const [index, call] of calls.entries()) {
            const batchIndex = index + 1;
            toolCalls += 1;

            if (call.type !== 'function') {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: formatToolError(`Вызовы типа "${call.type}" не поддерживаются`),
                });
                continue;
            }

            log.append({
                type: 'tool_call',
                callId: call.id,
                name: call.function.name,
                rawArguments: call.function.arguments,
                iteration,
                batchSize,
                batchIndex,
            });
            onProgress?.({
                kind: 'tool',
                iteration,
                maxIterations,
                name: call.function.name,
                batchIndex,
                batchSize,
            });

            const callStartedAt = Date.now();
            const toolSpan = tracer().startSpan(`execute_tool ${call.function.name}`, {
                attributes: toolCallAttributes(
                    call.function.name,
                    call.id,
                    call.function.arguments,
                    batchSize,
                    batchIndex,
                    captureContent,
                ),
            });
            const outcome = await executeCall(call);
            toolSpan.setAttributes(toolResultAttributes(outcome.content, captureContent));
            if (!outcome.ok) {
                toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'инструмент вернул ошибку' });
            }
            toolSpan.end();
            const content = truncate(outcome.content, toolResultMaxChars);

            log.append({
                type: 'tool_result',
                callId: call.id,
                name: call.function.name,
                ok: outcome.ok,
                content,
                durationMs: Date.now() - callStartedAt,
                batchSize,
                batchIndex,
            });

            // (г) tool_call_id обязателен и должен совпадать с идентификатором из ответа модели.
            messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
    }

    throw new IterationLimitError(maxIterations);
}

type CallOutcome = { readonly ok: boolean; readonly content: string };

/**
 * Исполняет один вызов. Ошибка инструмента — штатная ситуация, а не исключение: она
 * возвращается модели результатом вызова, чтобы та исправилась на следующей итерации.
 * Наверх пробрасывается только отмена прогона.
 */
async function executeCall(
    call: ChatCompletionMessageToolCall & { type: 'function' },
): Promise<CallOutcome> {
    const tool = toolByName.get(call.function.name);
    if (tool === undefined) {
        return {
            ok: false,
            content: formatToolError(
                `Инструмента "${call.function.name}" не существует`,
                `Доступны: ${tools.map((t) => t.name).join(', ')}. Вызови один из них.`,
            ),
        };
    }

    let args: Record<string, unknown>;
    try {
        const parsed: unknown =
            call.function.arguments === '' ? {} : JSON.parse(call.function.arguments);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('аргументы должны быть объектом JSON');
        }
        args = parsed as Record<string, unknown>;
    } catch (cause) {
        return {
            ok: false,
            content: formatToolError(
                `Аргументы вызова ${call.function.name} не разобраны: ${describe(cause)}`,
                `Повтори вызов, передав корректный объект JSON. Параметры: ${listParameters(tool.parameters)}.`,
            ),
        };
    }

    try {
        return { ok: true, content: JSON.stringify(await tool.execute(args)) };
    } catch (cause) {
        return {
            ok: false,
            content: formatToolError(
                `${call.function.name}: ${describe(cause)}`,
                `Параметры инструмента: ${listParameters(tool.parameters)}.`,
            ),
        };
    }
}

/**
 * Единый вид ошибки, возвращаемой модели. Текст пишется для модели как для адресата:
 * он не только сообщает, что произошло, но и предписывает, что делать дальше — иначе
 * модель повторяет тот же вызов.
 */
function formatToolError(message: string, hint?: string): string {
    return JSON.stringify({ error: true, message, ...(hint === undefined ? {} : { hint }) });
}

function listParameters(schema: Record<string, unknown>): string {
    const properties = schema['properties'];
    if (typeof properties !== 'object' || properties === null) return 'параметров нет';
    const required = new Set(
        Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
    );
    const names = Object.keys(properties as Record<string, unknown>);
    if (names.length === 0) return 'параметров нет';
    return names.map((name) => (required.has(name) ? `${name} (обязательный)` : name)).join(', ');
}

function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Ограничение размера результата. Без него один объёмный вывод занимает окно контекста
 * целиком, а поскольку каждая итерация отправляет всю историю заново, цена этого растёт
 * с каждой итерацией.
 */
function truncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const head = content.slice(0, maxChars);
    return `${head}\n… [результат усечён: показаны первые ${maxChars} из ${content.length} символов]`;
}
