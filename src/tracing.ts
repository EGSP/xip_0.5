import { diag, DiagLogLevel, trace, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { TracingConfig } from './config.js';

/**
 * Трассировка через OpenTelemetry.
 *
 * Экспорт выключен, пока не задан адрес коллектора: при пустом адресе провайдер вообще не
 * регистрируется, и вызовы `@opentelemetry/api` из остального кода становятся пустыми
 * операциями. Это то же решение, что в PIX: телеметрия никуда не уходит, пока получатель
 * не указан явно.
 *
 * Кодировка — protobuf, а не JSON. Формально OTLP по HTTP допускает обе, но принимают их
 * по-разному: Jaeger понимает и ту и другую, Phoenix — только protobuf и на JSON отвечает
 * кодом 415. Protobuf принимают все, поэтому выбран он.
 *
 * Остальной код обращается только к `@opentelemetry/api` и ничего не знает ни об экспортёре,
 * ни о выбранном бэкенде. Поэтому смена Jaeger на Langfuse или Grafana Tempo — это смена
 * одной переменной окружения, а не правка кода.
 */

const TRACER_NAME = 'xip-0.5';

let provider: NodeTracerProvider | undefined;

export function initTracing(config: TracingConfig): void {
    if (!config.enabled) return;

    // Сбои экспорта не должны прерывать работу агента: понижаем их до предупреждений.
    diag.setLogger(
        {
            error: (message) => process.stderr.write(`[otel] ${message}\n`),
            warn: () => {},
            info: () => {},
            debug: () => {},
            verbose: () => {},
        },
        DiagLogLevel.ERROR,
    );

    provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: config.serviceName,
            [ATTR_SERVICE_VERSION]: '0.5.0',
        }),
        spanProcessors: [
            new BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` })),
        ],
    });
    provider.register();
}

/**
 * Дожидается отправки накопленных спанов. Вызывается при завершении программы: пакетный
 * обработчик копит спаны и без явного сброса последний ход в коллектор не попадёт.
 */
export async function shutdownTracing(): Promise<void> {
    if (provider === undefined) return;
    try {
        await provider.shutdown();
    } catch {
        // Недоступный коллектор не должен мешать выходу из программы.
    }
}

export function tracer(): Tracer {
    return trace.getTracer(TRACER_NAME);
}
