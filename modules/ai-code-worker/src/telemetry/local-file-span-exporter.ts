import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { HrTime } from "@opentelemetry/api";
import type { SchemaRegistry } from "../schema/json-schema.js";

/**
 * Offline, zero-network span export (ADR-0012): appends one schema-validated JSON line
 * per finished span to `<runRoot>/otel-spans.jsonl`. Paired with `SimpleSpanProcessor`,
 * `export()` runs synchronously inside `span.end()`, so a span is durably on disk before
 * the run function that produced it returns - no shutdown/flush call is required for
 * correctness, matching the fully-synchronous run pipeline (see the ADR's "local file by
 * default" section for why an async/batched exporter was rejected for v1).
 */
export class LocalFileSpanExporter implements SpanExporter {
  constructor(
    private readonly path: string,
    private readonly registry: SchemaRegistry
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      for (const span of spans) {
        const record = toSpanRecord(span);
        this.registry.assertValid("otel-span.schema.json", record);
        appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function toSpanRecord(span: ReadableSpan): Record<string, unknown> {
  const spanContext = span.spanContext();

  return {
    schemaVersion: "1.0",
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: String(span.kind),
    startTimeUnixMillis: hrTimeToUnixMillis(span.startTime),
    endTimeUnixMillis: hrTimeToUnixMillis(span.endTime),
    attributes: span.attributes,
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixMillis: hrTimeToUnixMillis(event.time),
      attributes: event.attributes ?? {}
    })),
    status: { code: span.status.code, message: span.status.message ?? null }
  };
}

function hrTimeToUnixMillis(hrTime: HrTime): number {
  return hrTime[0] * 1000 + hrTime[1] / 1e6;
}
