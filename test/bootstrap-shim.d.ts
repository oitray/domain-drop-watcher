type ExecFileSyncFn = (cmd: string, args: string[], opts?: { encoding?: string; input?: string }) => string
type RandomBytesFn = (n: number) => { toString: (enc: string) => string }

interface BootstrapDeps {
  execFileSync?: ExecFileSyncFn
  randomBytes?: RandomBytesFn
}

declare module '../scripts/bootstrap-admin-token.mjs' {
  export function main(deps?: BootstrapDeps): Promise<void>
}
