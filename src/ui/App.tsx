import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { IterationLimitError, runTurn, SYSTEM_PROMPT, type TurnProgress } from '../agent-loop.js';
import type { AppConfig } from '../config.js';
import { ModelError, type ModelClient } from '../model-client.js';
import { createSessionLog, type SessionEvent } from '../session-log.js';
import { EventLine } from './EventLine.js';

export type AppProps = {
    readonly model: ModelClient;
    readonly config: AppConfig;
};

export function App({ model, config }: AppProps): ReactElement {
    const { exit } = useApp();

    const [events, setEvents] = useState<SessionEvent[]>([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<TurnProgress | undefined>(undefined);

    // Массив сообщений живёт между ходами и не участвует в отрисовке, поэтому хранится
    // в ссылке, а не в состоянии: его изменение не должно вызывать перерисовку.
    const messagesRef = useRef<ChatCompletionMessageParam[]>([
        { role: 'system', content: SYSTEM_PROMPT },
    ]);

    const logRef = useRef(
        createSessionLog((event) => {
            setEvents((previous) => [...previous, event]);
        }),
    );

    const abortRef = useRef<AbortController | undefined>(undefined);

    useInput((_value, key) => {
        if (key.escape && abortRef.current !== undefined) {
            abortRef.current.abort();
        }
    });

    const submit = useCallback(
        async (value: string): Promise<void> => {
            const text = value.trim();
            if (text === '' || busy) return;

            if (text === '/exit' || text === '/quit') {
                exit();
                return;
            }

            setInput('');
            setBusy(true);

            const log = logRef.current;
            log.append({ type: 'user_message', text });
            messagesRef.current.push({ role: 'user', content: text });

            const controller = new AbortController();
            abortRef.current = controller;

            try {
                await runTurn({
                    model,
                    messages: messagesRef.current,
                    log,
                    maxIterations: config.maxIterations,
                    toolResultMaxChars: config.toolResultMaxChars,
                    onProgress: setProgress,
                    signal: controller.signal,
                });
            } catch (error) {
                log.append({ type: 'turn_failed', ...classify(error) });
            } finally {
                abortRef.current = undefined;
                setProgress(undefined);
                setBusy(false);
            }
        },
        [busy, config.maxIterations, config.toolResultMaxChars, exit, model],
    );

    return (
        <Box flexDirection="column">
            <Static items={events}>{(event) => <EventLine key={event.seq} event={event} />}</Static>

            <Box marginTop={1}>
                {busy ? (
                    <Text color="yellow">
                        <Spinner type="dots" />
                        <Text>{` ${describeProgress(progress)}`}</Text>
                        <Text dimColor>{'   Esc — прервать ход'}</Text>
                    </Text>
                ) : (
                    <>
                        <Text color="cyan" bold>
                            {'› '}
                        </Text>
                        <TextInput
                            value={input}
                            onChange={setInput}
                            onSubmit={(value) => {
                                void submit(value);
                            }}
                            placeholder="сообщение агенту (/exit — выход)"
                        />
                    </>
                )}
            </Box>
        </Box>
    );
}

function describeProgress(progress: TurnProgress | undefined): string {
    if (progress === undefined) return 'подготовка';
    if (progress.kind === 'model') {
        return `шаг ${progress.step}/${progress.maxSteps} · обращение к модели`;
    }
    return `шаг ${progress.step}/${progress.maxSteps} · выполняется ${progress.name}`;
}

/**
 * Различает исходы неудачного хода. Сведённые в одно «ошибка», эти случаи требуют разной
 * реакции: предел шагов означает слишком крупную задачу, отказ модели — проблему на стороне
 * провайдера, отмена — намеренное действие пользователя.
 */
function classify(error: unknown): { reason: FailureReason; message: string } {
    if (error instanceof IterationLimitError) {
        return { reason: 'iteration_limit', message: error.message };
    }
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')) {
        return { reason: 'aborted', message: 'Ход прерван пользователем.' };
    }
    if (error instanceof ModelError) {
        return { reason: 'model_error', message: error.message };
    }
    return {
        reason: 'internal',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
}

type FailureReason = 'model_error' | 'iteration_limit' | 'aborted' | 'internal';
