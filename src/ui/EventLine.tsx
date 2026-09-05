import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { SessionEvent } from '../session-log.js';

/** Сжимает многострочное значение в одну строку и обрезает до предела. */
function oneLine(value: string, limit: number): string {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Короткая сводка результата вызова для ленты. Полный результат уходит модели, а человеку
 * нужен признак исхода и достаточно текста, чтобы понять, что произошло.
 */
function summariseResult(content: string, ok: boolean): string {
    if (!ok) {
        try {
            const parsed = JSON.parse(content) as { message?: unknown };
            if (typeof parsed.message === 'string') return oneLine(parsed.message, 160);
        } catch {
            // Ошибка пришла не в ожидаемом виде — показываем текст как есть.
        }
        return oneLine(content, 160);
    }
    return `${content.length} символов · ${oneLine(content, 110)}`;
}

const failureLabel: Record<string, string> = {
    model_error: 'ошибка модели',
    iteration_limit: 'превышен предел шагов',
    aborted: 'прервано',
    internal: 'внутренняя ошибка',
};

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

        case 'tool_call':
            return (
                <Box>
                    <Text color="yellow">
                        {'  ⚙ '}
                        {event.name}
                        <Text dimColor>({oneLine(event.rawArguments, 120)})</Text>
                    </Text>
                </Box>
            );

        case 'tool_result':
            return (
                <Box>
                    <Text color={event.ok ? 'green' : 'red'}>
                        {'    → '}
                        <Text dimColor={event.ok}>{summariseResult(event.content, event.ok)}</Text>
                        <Text dimColor>{` · ${event.durationMs} мс`}</Text>
                    </Text>
                </Box>
            );

        case 'assistant_message':
            return (
                <Box marginTop={1} flexDirection="column">
                    <Text>{event.text === '' ? '(модель вернула пустой ответ)' : event.text}</Text>
                </Box>
            );

        case 'turn_failed':
            return (
                <Box marginTop={1} flexDirection="column">
                    <Text color="red" bold>
                        {`Ход не завершён — ${failureLabel[event.reason] ?? event.reason}`}
                    </Text>
                    <Text color="red">{event.message}</Text>
                </Box>
            );
    }
}
