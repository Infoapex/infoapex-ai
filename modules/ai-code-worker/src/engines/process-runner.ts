import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { spawnBuffered, type BufferedProcessOptions, type BufferedProcessResult } from "./spawn-buffered.js";

/** The bounded process surface shared by provider adapters and execution backends. */
export interface EngineProcessOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string>>;
  readonly shell?: boolean;
  readonly watchdog?: BufferedProcessOptions["watchdog"];
}

export type EngineProcessSyncResult = SpawnSyncReturns<string>;

export interface EngineProcessRunner {
  readonly runSync: (executable: string, args: readonly string[], options: EngineProcessOptions) => EngineProcessSyncResult;
  readonly runAsync: (executable: string, args: readonly string[], options: EngineProcessOptions) => Promise<BufferedProcessResult>;
}

/** Host process runner used only by the explicit trusted/simulation paths. */
export const localEngineProcessRunner: EngineProcessRunner = {
  runSync(executable, args, options) {
    return spawnSync(executable, [...args], {
      cwd: options.cwd,
      input: options.input,
      env: options.env,
      encoding: "utf8",
      maxBuffer: options.maximumOutputBytes,
      timeout: options.timeoutMs,
      windowsHide: true,
      shell: options.shell ?? false
    });
  },
  runAsync(executable, args, options) {
    return spawnBuffered(executable, args, options);
  }
};
