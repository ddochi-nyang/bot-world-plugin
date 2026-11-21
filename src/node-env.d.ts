// Minimal Node.js ambient declarations for zero-dependency type checking against .orca/types/tsconfig.json.
declare namespace NodeJS {
  type ProcessEnv = Record<string, string | undefined>;
  interface ErrnoException extends Error {
    errno?: number;
    code?: string;
    path?: string;
    syscall?: string;
  }
}

declare var process: {
  readonly env: NodeJS.ProcessEnv;
  cwd(): string;
};

declare var Buffer: {
  byteLength(value: string, encoding?: string): number;
};

declare module 'node:child_process' {
  export type ExecFileOptions = {
    shell?: boolean;
    timeout?: number;
    maxBuffer?: number;
    env?: Record<string, string>;
    windowsHide?: boolean;
    signal?: AbortSignal;
  };
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void;
}

declare module 'node:fs' {
  export type Stats = {
    readonly mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
  export function lstatSync(path: string): Stats;
  export function statSync(path: string): Stats;
  export function realpathSync(path: string): string;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function chmodSync(path: string, mode: number): void;
  export function symlinkSync(target: string, path: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(path: string, options: { withFileTypes: true }): Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}
