# Durable OCR page batches implementation plan

**Goal:** Extract every page of long SECOP PDFs and test the scoped Flue agent with the existing fictional company and tender CO1.REQ.11093284 in Savia Preview.

**Architecture:** Keep the existing private OCR container and original R2 files. Process five original pages per bounded request; checkpoint owner/document/hash-bound accumulated pages in R2 and yield the saved extraction job between batches. Serialize typed processing failures across Workflow steps so continuation and busy conditions retain their meaning.

## Constraints and review focus

- No Savia platform changes or resource recreation; retain all credentials and data.
- Preserve original one-based page numbers; fail on missing, repeated, reordered or inconsistent batch pages.
- Only publish extraction evidence after every original page is present.
- Resume completed batches after service interruption without repeating OCR; reject different source hashes.
- Preserve nonretryable errors and retry saturation without consuming the page continuation failure budget.

## Tasks

- [x] Add failing Python tests for bounded page ranges beyond 20 total pages, last batches, invalid ranges and missing output; implement range OCR and HTTP forwarding (delegated, disjoint OCR files).
- [x] Add failing Worker tests for durable progress, interrupted resume, blank pages, missing/duplicate pages and source changes; implement checkpointed extraction and job continuation.
- [x] Add failing tests for serializable typed Workflow failures; preserve OCR continuation/busy semantics across steps.
- [x] Run full Worker, Python, infrastructure and security suites, type checks and built-module checks. Review combined diff.
- [ ] Integrate and deploy through the existing unified SECOP workflow; retry the original pliego, verify every page and current analysis, then run the fictional-company evaluation from Savia Preview and inspect citations/coverage.
