import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { IterationLimitError, runAgent, SYSTEM_PROMPT, type RunProgress } from '../agent-loop.js';
import type { AppConfig } from '../config.js';
import { ModelError } from '../model-client.js';
import { createSessionLog, type RunFailureReason, type SessionEvent } from '../session-log.js';
import type { ModelClient } from '../model-client.js';
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
    const [progress, setProgress] = useState<RunProgress | undefined>(undefined);
    const [elapsedMs, setElapsedMs] = useState(0);

    // Массив сообщений живёт между прогонами и не участвует в отрисовке, поэтому хранится
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

    // Счётчик времени идёт только во время прогона: в покое перерисовывать нечего.
    useEffect(() => {
        if (!busy) {
            setElapsedMs(0);
            return;
        }
        const startedAt = Date.now();
        const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
        return () => clearInterval(timer);
    }, [busy]);

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
                await runAgent({
                    model,
                    messages: messagesRef.current,
                    log,
                    maxIterations: config.maxIterations,
                    toolResultMaxChars: config.toolResultMaxChars,
                    captureContent: config.tracing.captureContent,
                    onProgress: setProgress,
                    signal: controller.signal,
                });
            } catch (error) {
                log.append({ type: 'run_failed', ...classify(error) });
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

            <Box flexDirection="column" marginTop={1}>
                <Box
                    borderStyle="round"
                    borderColor={busy ? 'yellow' : 'cyan'}
                    paddingX={1}
                    minHeight={3}
                >
                    {busy ? (
                        <Text color="yellow">
                            <Spinner type="dots" />
                            <Text>{` ${describeProgress(progress)}`}</Text>
                            <Text dimColor>{`  ·  ${(elapsedMs / 1000).toFixed(1)} с`}</Text>
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
                                placeholder="сообщение агенту"
                            />
                        </>
                    )}
                </Box>

                <Box paddingX={1}>
                    <Text dimColor>
                        {busy
                            ? 'Esc — прервать прогон'
                            : `${config.model}  ·  предел ${config.maxIterations} итер.  ·  /exit — выход`}
                    </Text>
                </Box>
            </Box>
        </Box>
    );
}

function describeProgress(progress: RunProgress | undefined): string {
    if (progress === undefined) return 'подготовка';
    const position = `итерация ${progress.iteration}/${progress.maxIterations}`;
    if (progress.kind === 'model') return `${position}  ·  обращение к модели`;
    const batch =
        progress.batchSize > 1 ? ` (${progress.batchIndex} из ${progress.batchSize})` : '';
    return `${position}  ·  ${progress.name}${batch}`;
}

/**
 * Различает исходы неудачного прогона. Сведённые в одно «ошибка», эти случаи требуют разной
 * реакции: предел итераций означает слишком крупную задачу, отказ модели — проблему на
 * стороне провайдера, отмена — намеренное действие пользователя.
 */
function classify(error: unknown): { reason: RunFailureReason; message: string } {
    if (error instanceof IterationLimitError) {
        return { reason: 'iteration_limit', message: error.message };
    }
    if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    ) {
        return { reason: 'aborted', message: 'Прогон прерван по нажатию Esc.' };
    }
    if (error instanceof ModelError) {
        return { reason: 'model_error', message: error.message };
    }
    return {
        reason: 'internal',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
}
