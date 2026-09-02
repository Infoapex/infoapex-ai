import { join } from "node:path";
import { context, trace, TraceFlags, type Context, type Span } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { sha256 } from "../manifest/normalize.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import type { RunEvent, RunEventType } from "../persistence/event-log.js";
import { LocalFileSpanExporter } from "./local-file-span-exporter.js";
import { toSpanAttributes } from "./redact-attributes.js";

export interface RunTelemetry {
  onEvent(event: RunEvent): void;
}

const NOOP_TELEMETRY: RunTelemetry = { onEvent: () => {} };

export function isOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INFOAPEX_OTEL_ENABLED === "1" || env.INFOAPEX_OTEL_ENABLED === "true";
}

export interface CreateRunTelemetryOptions {
  readonly runId: string;
  readonly runRoot: string;
  readonly registry?: SchemaRegistry;
  readonly env?: NodeJS.ProcessEnv;
}

interface PairSpec {
  readonly startType: RunEventType;
  readonly finishType: RunEventType;
  readonly keyFields: readonly string[];
}

/**
 * The only three lifecycle event pairs that become real, durationed spans (ADR-0012).
 * Every other RunEventType becomes an immediately-exported, zero-duration point span.
 */
const PAIR_SPECS: readonly PairSpec[] = [
  { startType: "task.started", finishType: "task.finished", keyFields: ["taskId"] },
  { startType: "gate.started", finishType: "gate.finished", keyFields: ["taskId", "gateId"] },
  { startType: "repair.attempt-started", finishType: "repair.attempt-finished", keyFields: ["taskId", "attempt"] }
];

const PAIR_SPEC_BY_START_TYPE = new Map(PAIR_SPECS.map((spec) => [spec.startType, spec]));
const PAIR_SPEC_BY_FINISH_TYPE = new Map(PAIR_SPECS.map((spec) => [spec.finishType, spec]));

/**
 * Builds a redacted OpenTelemetry sink for one EventLog instance's lifetime (ADR-0012).
 * Disabled by default: returns a no-op with no TracerProvider ever constructed, so
 * standalone/default usage is byte-for-byte unaffected. Enabled via
 * INFOAPEX_OTEL_ENABLED=1: every appended RunEvent is exported as a span the instant its
 * data is available (see the ADR for why no span is ever left open across process exit).
 */
export function createRunTelemetry(options: CreateRunTelemetryOptions): RunTelemetry {
  const env = options.env ?? process.env;
  if (!isOtelEnabled(env)) {
    return NOOP_TELEMETRY;
  }

  const registry = options.registry ?? SchemaRegistry.load();
  const exporter = new LocalFileSpanExporter(join(options.runRoot, "otel-spans.jsonl"), registry);
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "ai-code-worker" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  });
  const tracer = provider.getTracer("ai-code-worker");

  // One trace per runId, derived deterministically so two independently-constructed
  // RunTelemetry instances for the same run (compile.ts's, then a run file's) still
  // correlate under one trace ID without sharing a live object - see the ADR's "one
  // trace per run, without a live cross-phase parent object" section.
  const traceId = sha256(`otel-trace:${options.runId}`).slice(0, 32);
  const rootSpanId = sha256(`otel-root-span:${options.runId}`).slice(0, 16);

  const openTaskSpans = new Map<string, Span>();
  const openPairedSpans = new Map<string, Span>();

  function parentContextFor(spanId: string): Context {
    return trace.setSpanContext(context.active(), {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true
    });
  }

  function buildKey(fields: readonly string[], payload: Readonly<Record<string, unknown>>): string {
    return fields.map((field) => String(payload[field])).join(":");
  }

  function onEvent(event: RunEvent): void {
    const attributes = toSpanAttributes(event.payload);
    const taskId = typeof event.payload.taskId === "string" ? event.payload.taskId : undefined;
    const parentSpan = taskId ? openTaskSpans.get(taskId) : undefined;
    const parentContext = parentContextFor(parentSpan ? parentSpan.spanContext().spanId : rootSpanId);
    const time = new Date(event.createdAt);

    const startSpec = PAIR_SPEC_BY_START_TYPE.get(event.type);
    if (startSpec) {
      const span = tracer.startSpan(event.type, { attributes, startTime: time }, parentContext);
      openPairedSpans.set(`${startSpec.finishType}:${buildKey(startSpec.keyFields, event.payload)}`, span);
      if (event.type === "task.started" && taskId) {
        openTaskSpans.set(taskId, span);
      }
      return;
    }

    const finishSpec = PAIR_SPEC_BY_FINISH_TYPE.get(event.type);
    if (finishSpec) {
      const mapKey = `${event.type}:${buildKey(finishSpec.keyFields, event.payload)}`;
      const span = openPairedSpans.get(mapKey);
      if (span) {
        span.setAttributes(attributes);
        span.end(time);
        openPairedSpans.delete(mapKey);
        if (event.type === "task.finished" && taskId) {
          openTaskSpans.delete(taskId);
        }
        return;
      }
      // No matching start in this process's in-memory map (e.g. a resumed run whose
      // start event was appended by an earlier process invocation) - record what we
      // have as a point span instead of silently dropping it.
    }

    tracer.startSpan(event.type, { attributes, startTime: time }, parentContext).end(time);
  }

  return { onEvent };
}
