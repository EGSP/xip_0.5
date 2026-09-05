import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { calls as callsNoun } from '../plural.js';
import type { RunFailureReason, SessionEvent } from '../session-log.js';

/** Сжимает многострочное значение в одну строку и обрезает до предела. */
function oneLine(value: string, limit: number): string {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Аргументы вызова в компактной форме: без внешних фигурных скобок и кавычек у имён. */
function compactArgs(rawArguments: string): string {
    const flat = oneLine(rawArguments, 200);
    if (flat === '' || flat === '{}') return '';
    const withoutBraces = flat.startsWith('{') && flat.endsWith('}') ? flat.slice(1, -1) : flat;
    return oneLine(withoutBraces.replace(/"([A-Za-z_][\w]*)":/g, '$1: '), 96);
}

/**
 * Короткая сводка результата для ленты. Полный результат уходит модели, а человеку нужен
 * признак исхода и достаточно текста, чтобы понять, что произошло.
 */
function summariseResult(content: string, ok: boolean): string {
    if (!ok) {
        try {
            const parsed = JSON.parse(content) as { message?: unknown };
            if (typeof parsed.message === 'string') return oneLine(parsed.message, 150);
        } catch {
            // Ошибка пришла не в ожидаемом виде — показываем текст как есть.
        }
        return oneLine(content, 150);
    }
    return compactArgs(content) || oneLine(content, 96);
}

const failureLabel: Record<RunFailureReason, string> = {
    model_error: 'ошибка модели',
    iteration_limit: 'превышен предел итераций',
    aborted: 'прервано пользователем',
    internal: 'внутренняя ошибка',
};

/**
 * Обозначения для вызова внутри пакета. Модель может затребовать несколько вызовов одним
 * сообщением; в ленте они показываются деревом, чтобы это было видно с первого взгляда.
 */
function branchGlyphs(batchSize: number, batchIndex: number): { call: string; result: string } {
    if (batchSize === 1) return { call: '  ⏺ ', result: '    ⎿ ' };
    const last = batchIndex === batchSize;
    return { call: last ? '  └ ' : '  ├ ', result: last ? '      ⎿ ' : '  │   ⎿ ' };
}

function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;
}


export function EventLine({ event }: { readonly event: SessionEvent }): ReactElement {
    switch (event.type) {
        case 'user_message':
            return (
                <Box marginTop={1}>
                    <Text color="cyan" bold>
                        {'› '}
                        {event.text}
                    </Text>
                </Box>
            );

        case 'assistant_note':
            return (
                <Box marginTop={1} flexDirection="column">
                    <Text color="magenta" dimColor>
                        {'  ✎ текст модели вместе с вызовами:'}
                    </Text>
                    <Text color="magenta">{`    ${oneLine(event.text, 400)}`}</Text>
                </Box>
            );

        case 'tool_call': {
            const glyphs = branchGlyphs(event.batchSize, event.batchIndex);
            const args = compactArgs(event.rawArguments);
            const header =
                event.batchSize > 1 && event.batchIndex === 1 ? (
                    <Text color="yellow">
                        {'  ⏺ '}
                        <Text bold>{`${event.batchSize} ${callsNoun(event.batchSize)} одним ответом`}</Text>
                    </Text>
                ) : null;

            return (
                <Box flexDirection="column" marginTop={event.batchIndex === 1 ? 1 : 0}>
                    {header}
                    <Text color="yellow">
                        {glyphs.call}
                        <Text bold>{event.name}</Text>
                        {args === '' ? '' : <Text dimColor>{`  ${args}`}</Text>}
                    </Text>
                </Box>
            );
        }

        case 'tool_result': {
            const glyphs = branchGlyphs(event.batchSize, event.batchIndex);
            return (
                <Box>
                    <Text color={event.ok ? 'gray' : 'red'}>
                        {glyphs.result}
                        {event.ok ? '' : 'ошибка: '}
                        {summariseResult(event.content, event.ok)}
                        <Text dimColor>{`  ·  ${formatDuration(event.durationMs)}`}</Text>
                    </Text>
                </Box>
            );
        }

        case 'assistant_message':
            return (
                <Box marginTop={1} flexDirection="column">
                    <Text>{event.text === '' ? '(модель вернула пустой ответ)' : event.text}</Text>
                </Box>
            );

        case 'run_finished':
            return (
                <Box marginTop={1}>
                    <Text dimColor>
                        {`  ${event.iterations} итер.  ·  ${event.toolCalls} ${callsNoun(event.toolCalls)}` +
                            `  ·  ${event.promptTokens}→${event.completionTokens} ток.` +
                            `  ·  ${formatDuration(event.durationMs)}`}
                    </Text>
                </Box>
            );

        case 'run_failed':
            return (
                <Box marginTop={1} flexDirection="column">
                    <Text color="red" bold>{`  ✖ прогон не завершён — ${failureLabel[event.reason]}`}</Text>
                    <Text color="red">{`    ${event.message}`}</Text>
                </Box>
            );
    }
}
