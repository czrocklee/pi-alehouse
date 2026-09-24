export const packageRoot: string;
export function digest(bytes: string | Uint8Array): string;
export function agentDirectory(env?: NodeJS.ProcessEnv): string;
export function executable(name: string, override?: string, env?: NodeJS.ProcessEnv): string;
export function resolveFlock(env?: NodeJS.ProcessEnv): string;
export function webEntry(root?: string): string;
export function verifyRuntime(root?: string): string;
export function verifyAgentResources(agentDir?: string, root?: string): void;
export interface RuntimePaths {
  runtime: string;
  permissionRoot: string;
  policyRoot: string;
  flock: string;
  web: string;
  agentDir: string;
}
export function preflight(options?: { root?: string; env?: NodeJS.ProcessEnv; agentDir?: string }): RuntimePaths;
export interface ProtectionResources { writeRoots: string[]; readFiles: string[]; writeFiles?: string[] }
export function protectionResources(paths?: Partial<RuntimePaths>, env?: NodeJS.ProcessEnv, root?: string, hostRoot?: string): ProtectionResources;
export function runtimeEnvironment(paths: RuntimePaths, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
