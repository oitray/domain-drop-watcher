import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const WORKER_NAME = 'domain-drop-watcher'
const SECRET_NAME = 'ADMIN_TOKEN'

function checkSecretExists(workerName, secretName, runExecFileSync) {
  let output
  try {
    output = runExecFileSync(
      'wrangler',
      ['secret', 'list', '--name', workerName, '--format', 'json'],
      { encoding: 'utf8' }
    )
  } catch (err) {
    const msg = String(err?.message ?? err)
    if (
      msg.includes('script not found') ||
      msg.includes('does not exist') ||
      msg.includes('10007')
    ) {
      return false
    }
    throw new Error(`wrangler secret list failed unexpectedly: ${msg}`)
  }

  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(`wrangler secret list returned non-JSON output: ${output}`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`wrangler secret list returned non-array JSON: ${output}`)
  }

  return parsed.some((entry) => entry?.name === secretName)
}

export async function main(deps) {
  const runExecFileSync = deps?.execFileSync ?? execFileSync
  const genBytes = deps?.randomBytes ?? randomBytes

  if (checkSecretExists(WORKER_NAME, SECRET_NAME, runExecFileSync)) {
    process.stdout.write(
      `[bootstrap] ${SECRET_NAME} already exists — leaving unchanged.\n`
    )
    return
  }

  const token = genBytes(32).toString('base64url')

  runExecFileSync(
    'wrangler',
    ['secret', 'put', SECRET_NAME, '--name', WORKER_NAME],
    { input: token, encoding: 'utf8' }
  )

  const border = '='.repeat(60)
  process.stdout.write(
    `\n${border}\n` +
    `[bootstrap] ADMIN_TOKEN generated and stored as a Cloudflare Secret.\n` +
    `\n` +
    `  Token: ${token}\n` +
    `\n` +
    `Copy this token now — it will not be shown again.\n` +
    `Open your Worker URL and log in with this token.\n` +
    `\n` +
    `To rotate: delete the ADMIN_TOKEN Secret in the Cloudflare dashboard\n` +
    `(Workers & Pages -> domain-drop-watcher -> Settings -> Variables and Secrets)\n` +
    `then trigger a new deploy. The build log will show the new token once.\n` +
    `${border}\n\n`
  )
}

import { fileURLToPath } from 'node:url'

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[bootstrap] FATAL: ${err?.message ?? err}\n`)
    process.exit(1)
  })
}
