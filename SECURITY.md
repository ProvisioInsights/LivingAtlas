# Security Policy

Living Atlas is a private-first knowledge graph system. Security work must
preserve the core boundary: sensitive plaintext belongs only on trusted
keyholding clients, while hosted services may hold complete graph bytes only
under the access and encryption rules documented in the repository.

## Supported Versions

Living Atlas is in early development. Until versioned releases are published,
security fixes target the default branch. After public releases exist, this
policy will identify which release lines receive security updates.

## Reporting a Vulnerability

Please do not report exploitable security issues in public issues, pull
requests, discussions, or commit comments.

Use GitHub private vulnerability reporting for this repository when it is
available. If a private advisory channel is not available, open a minimal
public issue asking maintainers to provide a private contact path, without
including exploit details, secrets, account identifiers, real graph data, or
proof-of-concept payloads.

Useful private reports include:

- A short description of the affected component.
- The expected security boundary and the observed behavior.
- Reproduction steps using synthetic data only.
- Impact, affected versions or commits, and any known mitigations.
- Whether the issue may expose plaintext, keys, tokens, metadata, audit events,
  sync state, or deployment configuration.

## Scope

Security reports are especially relevant when they affect:

- Access-class enforcement, capability checks, or MCP authorization.
- Sensitive plaintext exposure to hosted services or remote providers.
- Encryption envelopes, key wrapping, device enrollment, or release expiry.
- Bootstrap, first-claim, sync, replay, or conflict-handling behavior.
- Metadata leakage through paths, manifests, indexes, logs, metrics, or audit.
- Public template safety for Cloudflare, Worker, Terraform/OpenTofu, or Wrangler
  configuration.
- Dependency vulnerabilities that are reachable in supported development or
  runtime paths.

Out of scope for coordinated vulnerability handling:

- Reports that rely on real private graph data, leaked credentials, or
  unauthorized access to a deployment.
- Social engineering, physical attacks, or denial-of-service testing against
  systems you do not own.
- Generic scanner output without a reachable Living Atlas impact.

## Safe Research Rules

- Use synthetic fixtures and throwaway test deployments.
- Do not attempt to access, modify, exfiltrate, or publish another person's
  graph, account, secrets, logs, or deployment state.
- Do not include raw tokens, private keys, recovery material, account IDs,
  domains, real graph content, or deployment-specific details in reports.
- Stop testing and report privately if you discover exposure of sensitive
  content or secrets.

## Disclosure

Maintainers will triage reports, work toward a fix, and coordinate disclosure
based on impact. Public disclosure should wait until a fix or mitigation is
available, unless maintainers and the reporter agree that earlier disclosure is
necessary to protect users.
