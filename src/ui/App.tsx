import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
    OutputLimitError,
    StepLimitError,
    runTurn,
    SYSTEM_PROMPT,
    type TurnProgress,
} from '../agent-loop.js';
import type { AppConfig } from '../config.js';
import { ModelError } from '../model-client.js';
import { createSessionLog, type TurnFailureReason, type SessionEvent } from '../session-log.js';
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
    const [progress, setProgress] = useState<TurnProgress | undefined>(undefined);
    const [elapsedMs, setElapsedMs] = useState(0);

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

    // Счётчик времени идёт только во время хода: в покое перерисовывать нечего.
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
                await runTurn({
                    model,
                    messages: messagesRef.current,
                    log,
                    maxSteps: config.maxSteps,
                    toolResultMaxChars: config.toolResultMaxChars,
                    captureContent: config.tracing.captureContent,
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
        [busy, config.maxSteps, config.toolResultMaxChars, exit, model],
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
                            ? 'Esc — прервать ход'
                            : `${config.model}  ·  предел ${config.maxSteps} шаг.  ·  /exit — выход`}
                    </Text>
                </Box>
            </Box>
        </Box>
    );
}

function describeProgress(progress: TurnProgress | undefined): string {
    if (progress === undefined) return 'подготовка';
    const position = `шаг ${progress.step}/${progress.maxSteps}`;
    if (progress.kind === 'model') return `${position}  ·  обращение к модели`;
    const batch =
        progress.batchSize > 1 ? ` (${progress.batchIndex} из ${progress.batchSize})` : '';
    return `${position}  ·  ${progress.name}${batch}`;
}

/**
 * Различает исходы неудачного хода. Сведённые в одно «ошибка», эти случаи требуют разной
 * реакции: предел шагов означает слишком крупную задачу, отказ модели — проблему на
 * стороне провайдера, отмена — намеренное действие пользователя.
 */
function classify(error: unknown): { reason: TurnFailureReason; message: string } {
    if (error instanceof StepLimitError) {
        return { reason: 'step_limit', message: error.message };
    }
    if (error instanceof OutputLimitError) {
        return { reason: 'output_limit', message: error.message };
    }
    if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    ) {
        return { reason: 'aborted', message: 'Ход прерван по нажатию Esc.' };
    }
    if (error instanceof ModelError) {
        return { reason: 'model_error', message: error.message };
    }
    return {
        reason: 'internal',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
}
