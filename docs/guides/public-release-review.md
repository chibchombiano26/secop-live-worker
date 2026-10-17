# Public release review

Reviewed on 2026-10-17 before changing repository visibility.

## Evidence

- Gitleaks 8.30.1, downloaded from its official GitHub release and checksum-verified, reported no credential findings in the full available Git history (48 non-merge commits scanned) or a clean archive of the tracked source.
- All 73 available Actions run log archives were downloaded and scanned with no credential findings. The repository had no uploaded Actions artifacts.
- Live credential files and database recovery exports do exist locally, outside version control. Their ignored status was verified; the repository-level ignore policy now also excludes agent sessions, private files, environment variants and tfvars.
- The checked-in Cloudflare account/resource IDs and host names identify configuration. They do not authorize access to D1, R2, the private service or deployment.
- The owner selected AGPL-3.0-only. LICENSE and NOTICE apply to the original project code; dependency licenses remain applicable.

Secret scanning is evidence, not a guarantee that every sensitive value or security defect has been detected. Review future contributions and generated outputs too. GitHub Actions logs/history become public along with the repository; removed credentials must be rotated even if history is later rewritten.

## Release protections

- Pull-request CI has explicit read-only permissions and no Cloudflare credentials. Checkout credentials are not persisted into untrusted build/test steps.
- Production deployment is manual and restricted in code to `main`.
- Only the credential check and final trusted reconciliation step receive the Cloudflare token; dependency installation and tests do not.
- CI caches only OCR source/build identity, not the full private release receipt or business-record counts. Recovery SQL and settings snapshots stay in the existing private R2 bucket.
- A checksum-pinned Gitleaks history scan now runs in CI, with redacted output.
- After publication, restrict the GitHub `production` environment to `main`, require review where supported, and require approval for outside-contributor workflows. Do not approve a production run for unreviewed source.

## Costs and visibility

Standard GitHub-hosted runner minutes are free for public repositories; larger runners and excess artifact/cache storage can still be charged. Cloudflare, OCR and model usage retain their existing costs. Publishing source does not make the application datasets, GitHub secrets or Cloudflare buckets public. It does make the source, configuration identifiers, commit metadata and available Actions logs public.

The owner authorized AGPL licensing, public release protections and history rewriting. See [repository security](repository-security.md) for hooks, required checks and history-rewrite limitations.

References: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility), [Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
