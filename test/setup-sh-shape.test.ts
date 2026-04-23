import setupShSource from '../scripts/setup.sh?raw';
import { describe, it, expect } from 'vitest';

const SETUP_SH: string = setupShSource;
const lines = SETUP_SH.split('\n');

describe('scripts/setup.sh shape lint', () => {
  it('starts with #!/usr/bin/env bash shebang', () => {
    expect(lines[0]).toBe('#!/usr/bin/env bash');
  });

  it('has set -euo pipefail within first 5 lines', () => {
    const head5 = lines.slice(0, 5).join('\n');
    expect(head5).toContain('set -euo pipefail');
  });

  it('never contains set -x', () => {
    expect(SETUP_SH).not.toContain('set -x');
  });

  it('never contains eval', () => {
    const evalLines = lines.filter(
      (line: string) => /\beval\b/.test(line) && !line.trimStart().startsWith('#'),
    );
    expect(evalLines).toHaveLength(0);
  });

  it('contains --email flag literal', () => {
    expect(SETUP_SH).toContain('--email');
  });

  it('contains --webhooks flag literal', () => {
    expect(SETUP_SH).toContain('--webhooks');
  });

  it('contains --rotate-admin flag literal', () => {
    expect(SETUP_SH).toContain('--rotate-admin');
  });

  it('contains --reconfigure flag literal', () => {
    expect(SETUP_SH).toContain('--reconfigure');
  });

  it('contains --help flag literal', () => {
    expect(SETUP_SH).toContain('--help');
  });

  it('contains wrangler whoami preflight', () => {
    expect(SETUP_SH).toContain('wrangler whoami');
  });

  it('generates admin token with URL-safe openssl pipeline', () => {
    expect(SETUP_SH).toContain(
      "openssl rand -base64 32 | tr '+/' '-_' | tr -d '='",
    );
  });

  it('preserves run_worker_first in wrangler.toml validation', () => {
    expect(SETUP_SH).toContain('run_worker_first');
  });
});
