# Unified SECOP Infrastructure Implementation Plan

**Goal:** Adopt existing SECOP resources without replacing storage or credentials and provide one repeatable deployment entry point.

**Architecture:** A checked-in production inventory pins resource identities. A dedicated OpenTofu live root imports supported persistent resources with destruction protection. A bounded API reconciler owns Vectorize metadata and validates index configuration; Wrangler owns OCR containers and their existing Durable Object migration. The deployment entry point preflights, backs up, adopts, builds, deploys and verifies both services, preserving secrets.

**Tech stack:** OpenTofu 1.13, Cloudflare provider 5.28, Wrangler, Node built-in test runner.

## Constraints

- No resource deletion, replacement, namespace change or data migration during adoption.
- Existing resource identities and all secret bindings remain unchanged.
- Vectorize remains 1024-dimensional cosine with ownerScope/tenderScope/generation string indexes.
- OCR remains private, CpuOcrContainer identity preserved, standard-2 and max_instances=1.
- No SECOP implementation in Savia core; all changes are in this repository.

## Tasks

- [x] Pin a non-secret inventory; implement imported, protected OpenTofu storage resources and validate a zero-change live adoption plan.
- [x] Test the reconciliation and deployment safety policies before implementation (wrong IDs, incompatible Vectorize, secret preservation, destructive plans, failed verification).
- [x] Implement the unified plan/deploy/check commands with private recovery artifacts and a local concurrency lock. Deploy OCR before the main service, preserve existing secret values, and verify resource identities and bindings afterwards.
- [x] Document adoption, permissions, state custody, rollback and normal deployment. Add infrastructure/OCR validation to CI and a serialized manual deployment workflow.
- [x] Run offline checks, adopt live resources, run the unified deployment and compare before/after records, resources, public MCP and private OCR configuration.

## Verification evidence

The first unified live release completed in 56 seconds. OpenTofu imported six existing resources with no remote create/update/delete actions. A second plan reported no imports and no infrastructure drift. Public health and the unauthenticated private API boundary passed; OCR retained its original namespace/application and immutable image digest.

Before/after D1 counts matched exactly: 38 chunks, 3 conversations, 12 documents, 2 dossiers, 49 messages, 162 reports, 226 requirements and 9 sources. The bucket has public r2.dev access disabled and no custom domains. Recovery artifacts and the verified release receipt were persisted in its private ops prefix.

Local validation: 172 Worker tests, 13 infrastructure tests, 12 OCR tests, Worker/OCR TypeScript checks and both OpenTofu configurations. The checked-in manual GitHub deployment workflow needs a repository/environment CLOUDFLARE_API_TOKEN secret; none was present and no credential was created/copied.
