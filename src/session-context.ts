import { hostname } from 'node:os';
import type { Attributes } from '@opentelemetry/api';

/**
 * Идентичность сессии и пользователя для телеметрии.
 *
 * Значения задаются один раз при запуске и добавляются ко всем спанам. В однопроцессной
 * программе достаточно модульного состояния; в серверной платформе то же самое пришлось бы
 * держать в контексте исполнения (в Effect — через `FiberRef`), поскольку одновременно
 * работают сессии разных пользователей.
 *
 * Зачем это нужно. Ход — это один обмен «сообщение пользователя → итоговый ответ», и
 * каждый ход образует отдельную трассировку. Диалог из пяти сообщений даёт пять
 * трассировок, между собой ничем не связанных. Атрибут `session.id` связывает их: приёмник
 * телеметрии собирает такие трассировки в одну сессию и показывает переписку целиком.
 *
 * Объединять ходы в один спан-корень было бы неверно: корневой спан закрывается только
 * при завершении сессии, поэтому до выхода из программы трассировка оставалась бы
 * незакрытой, а водопад по времени — бессмысленным, так как большую часть его длительности
 * занимало бы ожидание ввода пользователя.
 */

let attributes: Attributes = {};

/** Короткий читаемый идентификатор сессии: дата, время и четыре случайных символа. */
function generateSessionId(): string {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const suffix = Math.floor(Math.random() * 0xffff)
        .toString(16)
        .padStart(4, '0');
    return `${stamp}-${suffix}`;
}

/**
 * Идентификатор пользователя по умолчанию: имя машины с приставкой `l_`, обозначающей
 * локальный запуск. На сервере это место займёт идентификатор учётной записи.
 */
export function defaultUserId(): string {
    const machine = hostname()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
    return `l_${machine === '' ? 'unknown' : machine}`;
}

export type SessionContext = { readonly sessionId: string; readonly userId: string };

export function initSessionContext(options: {
    readonly sessionId?: string | undefined;
    readonly userId?: string | undefined;
}): SessionContext {
    const sessionId =
        options.sessionId !== undefined && options.sessionId !== ''
            ? options.sessionId
            : generateSessionId();
    const userId =
        options.userId !== undefined && options.userId !== '' ? options.userId : defaultUserId();

    attributes = {
        // OpenInference: по этим атрибутам Phoenix собирает вкладку «Sessions» и колонку user.
        'session.id': sessionId,
        'user.id': userId,
        // OpenTelemetry GenAI: то же понятие под именем, которое читает Langfuse.
        'gen_ai.conversation.id': sessionId,
    };

    return { sessionId, userId };
}

/** Атрибуты сессии, добавляемые к каждому спану. Пустой объект, пока контекст не задан. */
export function sessionAttributes(): Attributes {
    return attributes;
}
