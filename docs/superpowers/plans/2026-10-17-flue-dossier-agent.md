# Flue Dossier Agent Implementation Plan

> Execute natively in this session; preserve existing changes and validate each stage.

**Goal:** A private, durable, isolated Flue study agent per SECOP dossier behind Savia's chat.
**Architecture:** Same Worker and data stores; Flue on Agents SDK for durable sessions, Cloudflare Workflows for job orchestration, existing processors for validated evidence and answers.
**Tech Stack:** TypeScript, Flue 2.3, Cloudflare Workers/Workflows/Durable Objects, D1/R2/Vectorize.
**Spec:** docs/superpowers/specs/2026-10-17-flue-dossier-agent.md

## Tasks

- [x] Add failing owner/dossier/company/lease isolation tests and deterministic dispatch tests.
- [x] Add the scoped study adapter and agent with bounded, idempotent tools and private telemetry.
- [x] Introduce checkpointed Workflow job processing while preserving D1 retry/lease semantics.
- [x] Integrate Flue's Vite build with existing handlers/PDF assets and safe unified deployment.
- [x] Add resource/binding/migration safety tests and update infrastructure/operations guides.
- [ ] Run all tests, types, build, secret/dependency scanning; review and merge a green PR.
- [ ] Deploy without data/resource loss and test a saved dossier through Savia Preview.

## Review focus

Cross-owner identifiers; same-owner different dossiers; changed company or corpus
revision; concurrent/duplicate delivery; interrupted dispatch/read and expired
leases. Test these at the adapter/Workflow boundary. Preserve complete requirement
coverage, signed source URLs and company evidence restrictions.
