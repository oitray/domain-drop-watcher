import { describe, it, expect } from 'vitest'

const BASE64URL_43_RE = /^[A-Za-z0-9_-]{43}$/

type ExecFileSyncFn = (cmd: string, args: string[], opts?: { encoding?: string; input?: string }) => string
type RandomBytesFn = (n: number) => { toString: (enc: string) => string }

interface BootstrapDeps {
  execFileSync: ExecFileSyncFn
  randomBytes?: RandomBytesFn
}

type MainFn = (deps?: BootstrapDeps) => Promise<void>

let mainFn: MainFn | undefined

async function getMain(): Promise<MainFn> {
  if (!mainFn) {
    const mod = await import('../scripts/bootstrap-admin-token.mjs') as { main: MainFn }
    mainFn = mod.main
  }
  return mainFn
}

function makeExecFileSync(listOutput: string | Error, putError?: Error): ExecFileSyncFn & { calls: Array<[string, string[], unknown]> } {
  const calls: Array<[string, string[], unknown]> = []
  const fn = (cmd: string, args: string[], opts?: unknown) => {
    calls.push([cmd, args, opts])
    if (args[0] === 'secret' && args[1] === 'list') {
      if (listOutput instanceof Error) throw listOutput
      return listOutput
    }
    if (args[0] === 'secret' && args[1] === 'put') {
      if (putError) throw putError
      return ''
    }
    return ''
  }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn as ExecFileSyncFn & { calls: typeof calls }
}

describe('bootstrap-admin-token.mjs main()', () => {
  it('does not call wrangler secret put when ADMIN_TOKEN already listed', async () => {
    const main = await getMain()
    const listJson = JSON.stringify([{ name: 'ADMIN_TOKEN' }, { name: 'OTHER_SECRET' }])
    const mockExec = makeExecFileSync(listJson)

    await main({ execFileSync: mockExec })

    const putCalls = mockExec.calls.filter(([, args]) => args[1] === 'put')
    expect(putCalls.length).toBe(0)
  })

  it('generates a 43-char URL-safe base64 token and calls wrangler secret put via stdin when ADMIN_TOKEN absent', async () => {
    const main = await getMain()
    const listJson = JSON.stringify([{ name: 'OTHER_SECRET' }])
    const mockExec = makeExecFileSync(listJson)

    await main({ execFileSync: mockExec })

    const putCalls = mockExec.calls.filter(([, args]) => args[1] === 'put')
    expect(putCalls.length).toBe(1)

    const [cmd, args, opts] = putCalls[0]! as [string, string[], { input: string }]
    expect(cmd).toBe('wrangler')
    expect(args).toEqual(['secret', 'put', 'ADMIN_TOKEN', '--name', 'domain-drop-watcher'])
    expect(typeof opts.input).toBe('string')
    expect(BASE64URL_43_RE.test(opts.input)).toBe(true)
  })

  it('generated token is exactly 43 chars and matches URL-safe base64 charset', async () => {
    const main = await getMain()
    const listJson = JSON.stringify([])
    const capturedInputs: string[] = []

    const mockExec: ExecFileSyncFn = (cmd, args, opts) => {
      if (args[0] === 'secret' && args[1] === 'list') return listJson
      if (args[0] === 'secret' && args[1] === 'put' && opts?.input) capturedInputs.push(opts.input)
      return ''
    }

    await main({ execFileSync: mockExec })

    expect(capturedInputs.length).toBe(1)
    const token = capturedInputs[0]!
    expect(token).toHaveLength(43)
    expect(BASE64URL_43_RE.test(token)).toBe(true)
  })

  it('treats "script not found" wrangler error as absent and proceeds; re-throws other errors', async () => {
    const main = await getMain()

    const scriptNotFound = new Error('script not found (10007)')
    const mockExec = makeExecFileSync(scriptNotFound)

    await main({ execFileSync: mockExec })

    const putCalls = mockExec.calls.filter(([, args]) => args[1] === 'put')
    expect(putCalls.length).toBe(1)

    const networkError = new Error('network timeout')
    const mockExecBad = makeExecFileSync(networkError)

    await expect(main({ execFileSync: mockExecBad })).rejects.toThrow('wrangler secret list failed unexpectedly')
  })
})
