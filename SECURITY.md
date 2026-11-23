# Security policy

## Reporting a vulnerability in REE

REE parses untrusted, deliberately hostile files, so bugs in it matter. Please report privately:

- Use GitHub's **[Report a vulnerability](https://github.com/AnvitDevadiga/ree/security/advisories/new)** form, or
- open a minimal public issue that says only "security report — please contact me" if the form is unavailable.

Please don't post exploit details in a public issue.

### What counts

- A crafted artifact that makes REE crash, hang, exhaust memory, or exceed its documented parser limits.
- Any path where REE executes, evaluates, or loads content from the artifact it is analyzing.
- A prompt-injection payload that survives into a context slice or an MCP tool result outside the `untrustedArtifactData` envelope.
- Path traversal or writes outside the requested output location.

### What to include

The artifact format, a minimal sample you generated yourself, the REE version (`ree --version`, or `git rev-parse HEAD` from a checkout), and the command you ran.

## Supported versions

| Version | Supported |
|---|:-:|
| 2.x | ✅ |
| 1.x | ❌ — upgrade to 2.x |

Fixes land on `main` and in the latest release.

## Scope note

REE is a static analyzer intended for authorized analysis only. Reports about using REE against software you are not authorized to analyze are out of scope.
