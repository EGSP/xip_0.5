/**
 * Журнал событий сессии.
 *
 * Это вторая структура рядом с массивом сообщений, и различие между ними принципиально.
 * Массив сообщений — то, что уходит модели: он подчиняется формату API и со временем
 * перестаёт соответствовать происходившему (сжатие истории, свёртка старых результатов).
 * Журнал — перечень того, что фактически произошло, записями с порядковым номером;
 * записи добавляются в конец и не изменяются.
 *
 * На этом этапе журнал живёт в памяти и служит источником для интерфейса. Он введён рано
 * не потому, что нужен сейчас, а потому, что привычка считать массив сообщений единственным
 * хранилищем формируется быстро, а переделка затрагивает весь написанный вокруг него код.
 *
 * Терминология: **прогон** — одно исполнение агентского цикла от сообщения пользователя до
 * итогового ответа; **итерация** — один виток внутри прогона: обращение к модели плюс
 * исполнение вызовов, которые оно затребовало.
 */

export type RunFailureReason = 'model_error' | 'iteration_limit' | 'aborted' | 'internal';

export type SessionEvent =
    | { readonly seq: number; readonly at: Date; readonly type: 'user_message'; readonly text: string }
    /**
     * Текст, который модель прислала в одном сообщении с вызовами инструментов. Поле `content`
     * при вызовах необязательно: модель вправе не писать ничего. Событие появляется только
     * тогда, когда текст действительно был, — по нему видно, разговаривает ли конкретная
     * модель между вызовами или вызывает молча.
     */
    | {
          readonly seq: number;
          readonly at: Date;
          readonly type: 'assistant_note';
          readonly iteration: number;
          readonly text: string;
      }
    | {
          readonly seq: number;
          readonly at: Date;
          readonly type: 'tool_call';
          readonly callId: string;
          readonly name: string;
          readonly rawArguments: string;
          readonly iteration: number;
          /** Сколько вызовов модель затребовала одним сообщением. */
          readonly batchSize: number;
          /** Порядковый номер вызова внутри этого сообщения, начиная с единицы. */
          readonly batchIndex: number;
      }
    | {
          readonly seq: number;
          readonly at: Date;
          readonly type: 'tool_result';
          readonly callId: string;
          readonly name: string;
          readonly ok: boolean;
          readonly content: string;
          readonly durationMs: number;
          readonly batchSize: number;
          readonly batchIndex: number;
      }
    | {
          readonly seq: number;
          readonly at: Date;
          readonly type: 'assistant_message';
          readonly text: string;
      }
    | {
          readonly seq: number;
          readonly at: Date;
          readonly type: 'run_finished';
          readonly iterations: number;
          readonly toolCalls: number;
          readonly promptTokens: number;
          readonly completionTokens: number;
          readonly durationMs: number;
      }
    | {
          readonly seq: number;
          readonly at: Date;
          readonly type: 'run_failed';
          readonly reason: RunFailureReason;
          readonly message: string;
      };

/**
 * `Omit` по объединению типов схлопнул бы его до общих полей, поэтому применяем его
 * к каждому члену объединения по отдельности.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SessionEventInput = DistributiveOmit<SessionEvent, 'seq' | 'at'>;

export type SessionLog = {
    append(event: SessionEventInput): SessionEvent;
    readonly events: readonly SessionEvent[];
};

export function createSessionLog(onAppend?: (event: SessionEvent) => void): SessionLog {
    const events: SessionEvent[] = [];
    let seq = 0;

    return {
        append(input): SessionEvent {
            seq += 1;
            const event = { ...input, seq, at: new Date() } as SessionEvent;
            events.push(event);
            onAppend?.(event);
            return event;
        },
        get events() {
            return events;
        },
    };
}
