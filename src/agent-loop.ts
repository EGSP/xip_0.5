import type {
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ModelClient } from './model-client.js';
import type { SessionLog } from './session-log.js';
import { toolByName, toolSpecs, tools } from './tools.js';

export const SYSTEM_PROMPT = [
    'Ты — рабочий агент. У тебя есть инструменты; чтобы узнать факт о файловой системе или о времени,',
    'вызывай инструмент, а не предполагай.',
    'Не выдумывай данные. Если инструмент вернул ошибку — прочитай её текст и исправь вызов,',
    'а не повторяй тот же самый.',
    'Сначала вызовы инструментов, потом ответ: не пиши выводы в том же сообщении, где запрашиваешь',
    'данные для них.',
    'Отвечай пользователю по-русски и кратко.',
].join(' ');

/** Состояние текущего хода для живой области интерфейса. */
export type TurnProgress =
    | { readonly kind: 'model'; readonly step: number; readonly maxSteps: number }
    | { readonly kind: 'tool'; readonly step: number; readonly maxSteps: number; readonly name: string };

export class IterationLimitError extends Error {
    constructor(limit: number) {
        super(
            `Ход остановлен: превышен предел в ${limit} шагов. Задача, вероятно, слишком велика ` +
                'для одного хода, либо модель зациклилась на одном инструменте.',
        );
        this.name = 'IterationLimitError';
    }
}

export type RunTurnParams = {
    readonly model: ModelClient;
    /** Массив сообщений, отправляемый модели. Мутируется: ход дописывает в него свои записи. */
    readonly messages: ChatCompletionMessageParam[];
    readonly log: SessionLog;
    readonly maxIterations: number;
    readonly toolResultMaxChars: number;
    readonly onProgress?: (progress: TurnProgress) => void;
    readonly signal?: AbortSignal;
};

/**
 * Один ход агента.
 *
 * API модели не имеет памяти: каждое обращение отправляет весь массив сообщений заново.
 * Модель ничего не выполняет — она называет имя функции и аргументы, а выполняет программа,
 * кладёт результат в массив и отправляет массив снова. Ход завершается, когда ответ модели
 * не содержит требований вызова.
 */
export async function runTurn(params: RunTurnParams): Promise<string> {
    const { model, messages, log, maxIterations, toolResultMaxChars, onProgress, signal } = params;

    for (let step = 1; step <= maxIterations; step++) {
        onProgress?.({ kind: 'model', step, maxSteps: maxIterations });

        const message = await model.complete(messages, toolSpecs, signal);

        // (а) Ответ модели добавляется в массив как есть, вместе с идентификаторами вызовов:
        // сообщения с ролью "tool" привязаны к ним, и без них следующий запрос будет отвергнут.
        messages.push(message);

        const calls = message.tool_calls ?? [];

        // (б) Вызовов нет — модель ответила текстом, ход закончен.
        if (calls.length === 0) {
            const text = message.content ?? '';
            log.append({ type: 'assistant_message', text });
            return text;
        }

        // (в) Вызовы есть — выполняем каждый. Пропущенный результат сделает следующий запрос
        // невалидным, поэтому цикл проходит по всем вызовам без исключений.
        for (const call of calls) {
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
            });
            onProgress?.({ kind: 'tool', step, maxSteps: maxIterations, name: call.function.name });

            const startedAt = Date.now();
            const outcome = await executeCall(call);
            const content = truncate(outcome.content, toolResultMaxChars);

            log.append({
                type: 'tool_result',
                callId: call.id,
                name: call.function.name,
                ok: outcome.ok,
                content,
                durationMs: Date.now() - startedAt,
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
 * возвращается модели результатом вызова, чтобы та исправилась на следующем шаге. Наверх
 * пробрасывается только отмена хода.
 */
async function executeCall(call: ChatCompletionMessageToolCall & { type: 'function' }): Promise<CallOutcome> {
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
        const parsed: unknown = call.function.arguments === '' ? {} : JSON.parse(call.function.arguments);
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
    const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);
    const names = Object.keys(properties as Record<string, unknown>);
    if (names.length === 0) return 'параметров нет';
    return names.map((name) => (required.has(name) ? `${name} (обязательный)` : name)).join(', ');
}

function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Ограничение размера результата. Без него один объёмный вывод занимает окно контекста
 * целиком, а поскольку каждый шаг отправляет всю историю заново, цена этого растёт с
 * каждым шагом.
 */
function truncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const head = content.slice(0, maxChars);
    return `${head}\n… [результат усечён: показаны первые ${maxChars} из ${content.length} символов]`;
}
