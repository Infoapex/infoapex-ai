import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Write a complete JSON document beside its destination before publishing it.
 * A reader therefore observes either the old valid document or the new valid document,
 * never a partially-written state/manifest/evidence file. */
export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    // Flush before rename so an interrupted write cannot publish an unwritten file.
    const descriptor = openSync(temporary, "r");
    try {
      try { fsyncSync(descriptor); } catch (error) {
        // Windows/overlay filesystems can reject fsync for an otherwise durable local
        // file. The temp-write + rename protocol remains atomic; do not turn this
        // platform limitation into a partial publish.
        if (!(error && typeof error === "object" && "code" in error && ((error as { code?: string }).code === "EPERM" || (error as { code?: string }).code === "EINVAL"))) throw error;
      }
    } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function atomicWriteText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
