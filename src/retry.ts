/**
 * Повтор при сетевых отказах.
 *
 * Обращения к IAM и к модели идут по сети, и часть отказов не связана с запросом: обрыв
 * соединения, недоступность прокси, сброс на стороне посредника. Такие отказы устраняются
 * повтором, тогда как отказ из-за неверных данных запроса повтором не устраняется, поэтому
 * повторяются только сетевые ошибки, а ответы с кодом состояния — нет.
 *
 * Задержка растёт экспоненциально и размывается случайной добавкой (джиттером), чтобы
 * несколько одновременно упавших обращений не повторились синхронно.
 */

const DEFAULT_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;

/** Коды, при которых повтор осмыслен: соединение не установилось или было разорвано. */
const RETRYABLE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
]);

export function isRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === 'AbortError' || error.name === 'APIUserAbortError') return false;

    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && RETRYABLE_CODES.has(code)) return true;

    const inner = error.cause;
    if (inner instanceof Error) return isRetryable(inner);

    // Native fetch сообщает о любом сетевом отказе одинаково, пряча причину во вложенной ошибке;
    // если её нет, ориентируемся на само сообщение.
    return error.message === 'fetch failed';
}

/** Разворачивает вложенную причину в читаемый суффикс: «(ECONNRESET: socket hang up)». */
export function describeCause(error: unknown): string {
    if (!(error instanceof Error)) return '';
    const inner = error.cause;
    if (!(inner instanceof Error)) return '';
    const code = (inner as NodeJS.ErrnoException).code ?? inner.name;
    return ` (${code}: ${inner.message})`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
    operation: () => Promise<T>,
    options?: { readonly attempts?: number; readonly signal?: AbortSignal },
): Promise<T> {
    const attempts = options?.attempts ?? DEFAULT_ATTEMPTS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt === attempts || !isRetryable(error) || options?.signal?.aborted === true) {
                throw error;
            }
            const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
            await sleep(delay + Math.random() * delay);
        }
    }

    throw lastError;
}
