# Security Policy

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting:

https://github.com/oitray/domain-drop-watcher/security/advisories/new

Please include:
- Description of the issue
- Steps to reproduce
- Affected versions (main branch)
- Any suggested mitigations

Do not open a public GitHub issue for security vulnerabilities.

## Scope

This repository only. Cloudflare platform issues should be reported to
Cloudflare at https://www.cloudflare.com/trust-hub/vulnerability-disclosure-policy/.

## Supported versions

The `main` branch is the only supported version. There are no versioned releases
with long-term security support.

## Bug bounty

This is a FOSS project with no bug bounty program.

## Admin token threat model

**Admin token is generated in Workers Builds CI and stored as a Cloudflare Secret (encrypted at rest).** The token appears once in the build log for that deployment. Build logs are visible to dashboard users with Workers Platform Admin or equivalent on your Cloudflare account — the same trust boundary that already permits Secret reads. There is no broader exposure.

To rotate: delete the `ADMIN_TOKEN` Secret (Cloudflare dashboard → Workers & Pages → your worker → Settings → Variables and Secrets) and redeploy. The build log for the new deploy will show the new token once.

**`*.workers.dev` enumerability.** Cloudflare issues TLS certificates for all `*.workers.dev` subdomains. These certificates are logged to public Certificate Transparency logs (e.g., crt.sh), making your worker subdomain enumerable by anyone watching CT logs. This is a Cloudflare platform property, not a bug in this tool. There is no public bootstrap endpoint in this codebase — the admin token is never accessible via an HTTP response.
