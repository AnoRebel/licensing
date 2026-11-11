# Security Policy

## Supported versions

Security fixes land on the latest minor release of the current major.
The npm, JSR and Go module artefacts ship at the same version, so a fix
covers all three.

| Version | Supported |
| ------- | --------- |
| 1.x     | yes       |
| < 1.0   | no        |

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/AnoRebel/licensing/security/advisories/new).
Do not open a public issue.

Include the affected version(s), the component (Go module, TS SDK, admin UI,
token format), and steps or a proof of concept to reproduce. You can expect
an acknowledgement within a few days. Fixes are released with a GitHub
Security Advisory and credited to the reporter unless you prefer otherwise.

The threat model and security posture are documented in
[`docs/threat-model.md`](docs/threat-model.md) and
[`docs/security.md`](docs/security.md).
