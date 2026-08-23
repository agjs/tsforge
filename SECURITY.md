# Security

tsforge is a local AI coding harness. Treat it like running an untrusted developer on your machine.

## What tsforge executes

- The model can invoke **shell commands** (`run` tool) inside the **target project** you point it at
- The model can **read and write files** in that project via edit/create/hashline tools
- Run tsforge only against projects you trust, or inside containers/sandboxes

## Network

- **No telemetry** — tsforge does not phone home
- Network calls go only to the **model endpoint** you configure (`~/.tsforge/models.json` or `TSFORGE_BASE_URL`)
- Eval scripts may call a separate judge endpoint (`TSFORGE_JUDGE_*`)

## Reporting

Report vulnerabilities via [GitHub security advisories](https://github.com/boringstack-xyz/tsforge/security/advisories/new) on boringstack-xyz/tsforge.

Do not open public issues for exploitable findings.
