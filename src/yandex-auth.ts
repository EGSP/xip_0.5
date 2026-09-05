import { importPKCS8, SignJWT } from 'jose';
import type { AuthConfig, ServiceAccountKey } from './config.js';
import { describeCause, withRetry } from './retry.js';

/** Эндпоинт обмена подписанного JWT на IAM-токен. */
const IAM_TOKENS_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';

/** Алгоритм подписи, который требует Yandex (RSASSA-PSS + SHA-256); совместим с ключом RSA_2048. */
const JWT_ALG = 'PS256';

/** Срок жизни самого JWT (не IAM-токена). Yandex принимает не больше часа. */
const JWT_TTL = '1h';

/** Перевыпускаем IAM-токен заранее, за этот зазор до заявленного истечения. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Запасной срок жизни кеша, если ответ IAM не содержит времени истечения. */
const DEFAULT_TTL_MS = 50 * 60 * 1000;

/**
 * В поле `private_key` файла authorized_key.json Yandex добавляет перед PEM строку
 * «PLEASE DO NOT REMOVE THIS LINE! Yandex.Cloud SA Key ID …», которую jose не принимает.
 */
const PKCS8_PEM_RE = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/;

export class YandexAuthError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'YandexAuthError';
    }
}

export type IamToken = {
    readonly token: string;
    /** Момент, после которого токен следует перевыпустить (с учётом зазора). */
    readonly refreshAtMs: number;
};

export type TokenProvider = {
    /** Возвращает действующий IAM-токен, при необходимости выпуская новый. */
    getToken(): Promise<string>;
    /** Сведения о текущем токене — для диагностики; выпуск не инициирует. */
    peek(): IamToken | undefined;
};

function extractPkcs8Pem(privateKey: string): string {
    const match = PKCS8_PEM_RE.exec(privateKey);
    if (match === null) {
        throw new YandexAuthError(
            'YANDEX_PRIVATE_KEY: не найден блок -----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----. ' +
                'Скопируйте значение private_key из authorized_key.json целиком, заменив переносы строк на \\n.',
        );
    }
    return match[0];
}

/**
 * Подписывает JWT ключом сервисного аккаунта и обменивает его на IAM-токен. Это тот же поток,
 * который выполняет `yc iam create-token`, только внутри программы.
 */
async function requestIamToken(key: ServiceAccountKey): Promise<IamToken> {
    const signingKey = await importPKCS8(extractPkcs8Pem(key.privateKey), JWT_ALG);
    const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: JWT_ALG, kid: key.keyId, typ: 'JWT' })
        .setIssuer(key.serviceAccountId)
        .setAudience(IAM_TOKENS_URL)
        .setIssuedAt()
        .setExpirationTime(JWT_TTL)
        .sign(signingKey);

    const response = await withRetry(async () => {
        try {
            return await fetch(IAM_TOKENS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jwt }),
            });
        } catch (cause) {
            throw new YandexAuthError(
                `Не удалось обратиться к сервису IAM: ${cause instanceof Error ? cause.message : String(cause)}` +
                    describeCause(cause),
                { cause },
            );
        }
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new YandexAuthError(
            `Обмен JWT на IAM-токен не удался: HTTP ${response.status}. ${body}`.trim(),
        );
    }

    const data = (await response.json()) as { iamToken?: string; expiresAt?: string };
    if (data.iamToken === undefined || data.iamToken === '') {
        throw new YandexAuthError('Ответ IAM не содержит поля iamToken');
    }

    const refreshAtMs =
        data.expiresAt === undefined
            ? Date.now() + DEFAULT_TTL_MS
            : Date.parse(data.expiresAt) - REFRESH_SKEW_MS;

    return { token: data.iamToken, refreshAtMs };
}

/**
 * Создаёт поставщика IAM-токена по выбранному способу аутентификации.
 *
 * Для готового токена срок жизни неизвестен, поэтому обновление невозможно: когда токен
 * истечёт, обращения к модели начнут отклоняться и программу придётся перезапустить.
 * Для ключа сервисного аккаунта токен кешируется и перевыпускается заблаговременно;
 * параллельные запросы при истёкшем кеше разделяют один обмен.
 */
export function createTokenProvider(auth: AuthConfig): TokenProvider {
    if (auth.kind === 'static') {
        const token: IamToken = { token: auth.token, refreshAtMs: Number.POSITIVE_INFINITY };
        return {
            getToken: async () => token.token,
            peek: () => token,
        };
    }

    let cached: IamToken | undefined;
    let inflight: Promise<IamToken> | undefined;

    return {
        async getToken(): Promise<string> {
            if (cached !== undefined && Date.now() < cached.refreshAtMs) {
                return cached.token;
            }
            if (inflight === undefined) {
                inflight = requestIamToken(auth.key).finally(() => {
                    inflight = undefined;
                });
            }
            cached = await inflight;
            return cached.token;
        },
        peek: () => cached,
    };
}
