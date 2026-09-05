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
 */

export type SessionEvent =
    | { readonly seq: number; readonly at: Date; readonly type: 'user_message'; readonly text: string }
    | {
          readonly seq: number;
          readonly at: Date;
          readonly type: 'tool_call';
          readonly callId: string;
          readonly name: string;
          readonly rawArguments: string;
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
          readonly type: 'turn_failed';
          readonly reason: 'model_error' | 'iteration_limit' | 'aborted' | 'internal';
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
