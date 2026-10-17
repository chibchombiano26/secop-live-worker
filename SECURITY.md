# Security policy

Do not open a public issue containing credentials, private tender documents,
company evidence or production logs. Use GitHub private vulnerability reporting
from this repository's Security tab.

Only the current `main` branch is maintained. Install local leak-prevention hooks
with `npm run security:setup` before contributing. See
[security controls](docs/guides/repository-security.md).

Scanning cannot guarantee that a value is safe to publish. If a real secret is
exposed, revoke or rotate it first, then investigate history, logs and artifacts.
Deleting a commit or making a repository private does not revoke credentials.
