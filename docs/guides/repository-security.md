# Repository security and public release

## License

Original project code uses AGPL-3.0-only. Commercial use is allowed. Modified
network deployments must offer their corresponding source to interacting users
under the AGPL; dependency notices and licenses remain applicable. See LICENSE
and NOTICE. The repository license does not grant access to the hosted service,
Cloudflare account, private datasets or deployment credentials.

## Local hooks

Run `npm run security:setup` after cloning. It downloads Gitleaks 8.30.1 from the
official release, verifies a pinned SHA-256, and enables the checked-in pre-commit
and pre-push hooks for this clone. macOS and Linux (ARM64/x64) are supported.
Hooks fail closed if the scanner is missing. Repeat setup in every new clone;
Git does not distribute local Git configuration automatically.

Pre-commit scans the staged diff; pre-push scans outgoing commits, including
credentials subsequently removed. Both redact findings. Private paths such as
`.env`, `.dev.vars`, `.superpowers`, state and `*.private.*` are also rejected,
even when they contain no recognizable token. `.env.example` and `.env.sample`
are allowed, but must contain placeholders. Use `npm run security:scan` for the
full history. Hooks can be bypassed locally, so server-side protection and PR
checks remain necessary. Do not use `--no-verify` to bypass a real finding.

## GitHub controls

Public repository protections include secret scanning and push protection,
private vulnerability reporting, Dependabot vulnerability alerts/updates,
read-only Actions tokens, SHA-pinned allowlisted actions, and approval of every
external contributor's workflow. Gitleaks is a required PR status check, along
with tests/types and dependency review. CodeQL scans supported source languages.
CODEOWNERS identifies the maintainer for code and security changes. Main branch
protection rejects force pushes/deletion and unresolved review conversations.

Deployment remains manual, `main` only, with the production environment restricted
to that branch. Only the credential check and final reconciliation receive the
Cloudflare secret. PR workflows never receive production credentials. Changes to
workflows, hooks, dependencies and permissions require particular maintainer
attention: a malicious contribution can alter its own checks unless reviewed.

GitHub's native rules detect supported credential formats; Gitleaks adds patterns,
not proof that every password or private datum will be caught. No secret/data
recovery exports belong in caches or uploaded artifacts. Only sanitized OCR build
identity is cached. Keep GitHub's dependency alerts under review after publication.

## History rewrite

Before publication, the current tracked tree is copied into one new root commit;
a private, verified local Git bundle retains the original history. Main is updated
using an exact `--force-with-lease`, and merged remote development branches are
removed so they do not advertise the old history. No application deployment,
resource recreation, database migration or secret rotation is part of this action.

Existing clones must re-clone, then reinstall hooks, rather than merge the old
history back. Do not push old local branches or tags. A rewrite is not secure
erasure: GitHub can retain closed-PR refs/cached commits and others may have
clones. GitHub Support handles qualifying sensitive-data removal requests; no
credentials were detected in the audited history. Never claim that a root reset
purges every previous copy.
