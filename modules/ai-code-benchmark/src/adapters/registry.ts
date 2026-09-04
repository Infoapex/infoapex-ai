import type { AdapterDoctorReport, BenchmarkAdapter, BenchmarkConfig } from "../types.js";
import { DirectClaudeAdapter } from "./direct-claude.js";
import { DirectCodexAdapter } from "./direct-codex.js";
import { FakeAdapter } from "./fake.js";
import { InfoapexRootAdapter } from "./infoapex-root.js";

export function createAdapter(kind: "codex" | "claude" | "infoapex" | "fake", config: BenchmarkConfig): BenchmarkAdapter {
  if (kind === "codex") return new DirectCodexAdapter(config.commands.codex);
  if (kind === "claude") return new DirectClaudeAdapter(config.commands.claude);
  if (kind === "infoapex") return new InfoapexRootAdapter(config.commands.infoapex);
  return new FakeAdapter();
}

export async function doctorConfiguredAdapters(config: BenchmarkConfig): Promise<readonly AdapterDoctorReport[]> {
  return Promise.all([createAdapter("codex", config).doctor(), createAdapter("claude", config).doctor(), createAdapter("infoapex", config).doctor()]);
}
