# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/mssh21/needmark/security/advisories/new), not in a public issue. Include the NeedMark version, how you run it (Vite plugin, review proxy, CLI or MCP) and steps to reproduce.

## Supported versions

Security fixes are released for the latest published version.

## Scope

NeedMark runs only on your machine during development. Reports are especially welcome for:

- access to the local review API from another origin or site;
- NeedMark code or feedback files reaching production builds;
- reading or writing files outside the project or feedback directory;
- saved comments, page text or replies being executed or treated as instructions.

The security boundaries are described in [docs/architecture.md](docs/architecture.md#activation-and-boundaries).
