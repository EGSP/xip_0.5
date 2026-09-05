import type { Attributes } from '@opentelemetry/api';
import type {
    ChatCompletionMessage,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { sessionAttributes } from './session-context.js';

/**
 * Атрибуты спанов в двух наборах соглашений сразу.
 *
 * Приёмники телеметрии договорились по-разному. Семантические соглашения OpenTelemetry для
 * GenAI (`gen_ai.*`) понимает Langfuse; соглашения OpenInference (`llm.*`, `openinference.*`)
 * понимает Phoenix. Наборы не конфликтуют — это просто разные имена атрибутов на одном спане,
 * — поэтому проще выставить оба, чем привязываться к одному приёмнику.
 *
 * Различие содержательное, а не только в именах. `gen_ai.*` описывает обращение к модели
 * плоскими значениями: модель, температура, число токенов. OpenInference дополнительно
 * раскладывает сам диалог по сообщениям (`llm.input_messages.0.message.role` и так далее),
 * и именно из этой раскладки Phoenix собирает вид переписки. Без неё он показал бы такой же
 * водопад, как Jaeger.
 */

/** Текстовое содержимое сообщения; части-массивы сводятся к тексту. */
function contentOf(message: ChatCompletionMessageParam): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                typeof part === 'object' && part !== null && 'text' in part
                    ? String((part as { text: unknown }).text)
                    : '',
            )
            .join('');
    }
    return '';
}

/** Атрибуты запроса к модели: параметры и разложенный по сообщениям вход. */
export function chatRequestAttributes(
    modelName: string,
    modelUri: string,
    temperature: number,
    messages: readonly ChatCompletionMessageParam[],
    tools: readonly ChatCompletionTool[],
    captureContent: boolean,
): Attributes {
    const attributes: Attributes = {
        ...sessionAttributes(),
        // OpenTelemetry GenAI
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': 'yandex',
        'gen_ai.request.model': modelUri,
        'gen_ai.request.temperature': temperature,
        // OpenInference
        'openinference.span.kind': 'LLM',
        'llm.model_name': modelName,
        'llm.provider': 'yandex',
        'llm.system': 'openai',
        'llm.invocation_parameters': JSON.stringify({ temperature, tool_count: tools.length }),
    };

    if (!captureContent) return attributes;

    attributes['input.value'] = JSON.stringify({ messages });
    attributes['input.mime_type'] = 'application/json';

    messages.forEach((message, index) => {
        const prefix = `llm.input_messages.${index}.message`;
        attributes[`${prefix}.role`] = message.role;
        const text = contentOf(message);
        if (text !== '') attributes[`${prefix}.content`] = text;

        // Вызовы инструментов, затребованные моделью на прошлом шаге.
        const toolCalls = (message as { tool_calls?: readonly unknown[] }).tool_calls;
        if (Array.isArray(toolCalls)) {
            toolCalls.forEach((call, callIndex) => {
                const fn = (call as { function?: { name?: string; arguments?: string } }).function;
                if (fn === undefined) return;
                const callPrefix = `${prefix}.tool_calls.${callIndex}.tool_call.function`;
                attributes[`${callPrefix}.name`] = fn.name ?? '';
                attributes[`${callPrefix}.arguments`] = fn.arguments ?? '';
            });
        }
    });

    tools.forEach((tool, index) => {
        attributes[`llm.tools.${index}.tool.json_schema`] = JSON.stringify(tool);
    });

    return attributes;
}

/** Атрибуты ответа модели: расход токенов и разложенный выход. */
export function chatResponseAttributes(
    message: ChatCompletionMessage,
    promptTokens: number,
    completionTokens: number,
    captureContent: boolean,
    reasoning?: string | undefined,
    finishReason?: string | undefined,
): Attributes {
    const attributes: Attributes = {
        'gen_ai.usage.input_tokens': promptTokens,
        'gen_ai.usage.output_tokens': completionTokens,
        'gen_ai.response.tool_calls': message.tool_calls?.length ?? 0,
        'llm.token_count.prompt': promptTokens,
        'llm.token_count.completion': completionTokens,
        'llm.token_count.total': promptTokens + completionTokens,
        ...(finishReason === undefined ? {} : { 'gen_ai.response.finish_reasons': [finishReason] }),
    };

    if (!captureContent) return attributes;

    attributes['output.value'] = JSON.stringify(message);
    attributes['output.mime_type'] = 'application/json';
    attributes['llm.output_messages.0.message.role'] = 'assistant';
    if (finishReason !== undefined) {
        attributes['llm.output_messages.0.message.finish_reason'] = finishReason;
    }

    const text = message.content ?? '';

    if (reasoning !== undefined) {
        // Сообщение с рассуждением раскладывается на части. Приёмник показывает часть с типом
        // `reasoning` отдельным блоком в виде переписки; при этом `message.content` выставлять
        // нельзя — иначе текст ответа отобразится дважды.
        const parts = `llm.output_messages.0.message.contents`;
        attributes[`${parts}.0.message_content.type`] = 'reasoning';
        attributes[`${parts}.0.message_content.text`] = reasoning;
        if (text !== '') {
            attributes[`${parts}.1.message_content.type`] = 'text';
            attributes[`${parts}.1.message_content.text`] = text;
        }
    } else if (text !== '') {
        attributes['llm.output_messages.0.message.content'] = text;
    }
    message.tool_calls?.forEach((call, index) => {
        if (call.type !== 'function') return;
        const prefix = `llm.output_messages.0.message.tool_calls.${index}.tool_call`;
        attributes[`${prefix}.id`] = call.id;
        attributes[`${prefix}.function.name`] = call.function.name;
        attributes[`${prefix}.function.arguments`] = call.function.arguments;
    });

    if (reasoning !== undefined) {
        // Стандартного имени для текста рассуждения нет ни в одном из наборов соглашений,
        // поэтому кладём его под собственным ключом; в интерфейсе приёмника он виден
        // в перечне атрибутов спана.
        // Дублируется плоским ключом: его читают приёмники, не понимающие раскладку на части.
        attributes['gen_ai.completion.reasoning'] = reasoning.slice(0, 16000);
    }

    return attributes;
}

/** Атрибуты вызова инструмента. */
export function toolCallAttributes(
    name: string,
    callId: string,
    rawArguments: string,
    batchSize: number,
    batchIndex: number,
    captureContent: boolean,
): Attributes {
    const attributes: Attributes = {
        ...sessionAttributes(),
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': name,
        'gen_ai.tool.call.id': callId,
        'openinference.span.kind': 'TOOL',
        'tool.name': name,
        'agent.batch_size': batchSize,
        'agent.batch_index': batchIndex,
    };
    if (captureContent) {
        attributes['tool.parameters'] = rawArguments;
        attributes['input.value'] = rawArguments;
        attributes['input.mime_type'] = 'application/json';
    }
    return attributes;
}

/** Атрибуты результата вызова инструмента. */
export function toolResultAttributes(content: string, captureContent: boolean): Attributes {
    if (!captureContent) return {};
    const trimmed = content.slice(0, 8000);
    return {
        'gen_ai.tool.result': trimmed,
        'output.value': trimmed,
        'output.mime_type': 'application/json',
    };
}
