# Private CPU OCR on Cloudflare Containers

The SECOP service can fall back from native PDF text extraction to OCRmyPDF and
Tesseract (Spanish + English). No Savia host code, GPU or external LLM is needed
for OCR. Text remains derived evidence requiring human source review.

The `ocr/` Worker has no public workers.dev URL or routes. Only the service
binding `SECOP_OCR` reaches it. It forwards raw PDFs to one fixed Durable Object
and one container, with internet access disabled. Instances use `standard-2`
(1 vCPU, 6 GiB RAM, 12 GB disk) and sleep 10 seconds after completing a request.
No user-supplied routing URL or filename reaches a shell.

## Deploy

Docker must be running when OCR sources or its live image/version changed.
From the repository root run `npm run infra:plan`, then `npm run infra:deploy`.
The unified command deploys the existing OCR service before SECOP and verifies
the original Durable Object namespace, application ID and capacity. It preserves
all SECOP bindings/secrets. Unchanged, previously verified OCR releases skip
container rebuilding.

Do not deploy the live service from placeholder Wrangler/OpenTofu configurations.
See [infrastructure and recovery](infrastructure.md) for adoption, permissions,
backups, state and rollback. `ocr/wrangler.jsonc` remains the declarative OCR
configuration consumed by this entry point; no Savia platform deployment is needed.

## Behavior and limits

Readable files stay on the existing extractor. PDF extraction that yields no
text or empty pages falls back to CPU OCR. An explicitly configured external
`EXTRACTOR_URL` still takes precedence. Other file types remain on the existing
extractor. Original files stay private in R2; temporary container files are
removed after each request. OCR results preserve 1-based page numbers.

The container accepts PDFs up to 25 MiB and processes one request at a time.
Legacy whole-document requests remain limited to 20 pages. Longer PDFs use
explicit ranges: each request processes at most five original pages, and the
total document page count has no 20-page cap. The container separates those
pages from the original PDF, OCRs only the requested range, and returns the
original 1-based page numbers and the next page to process. It rejects a range
if text extraction returns fewer or more pages than requested, so blank pages
are retained and missing pages cannot be silently skipped. Each request has a
78-second subprocess deadline. The existing ingestion safety limits (25 MiB source,
10,000 pages and 8 million extracted characters) still reject excessive documents
explicitly; they never truncate a successful extraction.

The backend checkpoints each completed page batch before scheduling the next
range. Checkpoints are private R2 objects scoped to the authenticated owner,
document and source-byte hash. Delayed queue delivery continues the next range
promptly, with the cron outbox as recovery if a send fails. Retries resume from the next unprocessed original page, and a document
is reported complete only when the final page has been processed. Busy/startup
failures remain retryable; oversized, encrypted, invalid or timed-out documents
remain explicit failures rather than partial successful extractions.

Recovered documents clear their old error, invalidate the partial report and
schedule synthesis with a new corpus revision. Old conversations retain their
revision and can be identified as stale. OCR text always carries a review flag;
successful processing is not a guarantee of transcription accuracy.

## Verify

```sh
python3 -m unittest discover -s ocr/container/tests -p 'test_*.py'
worker/node_modules/.bin/tsc -p ocr/tsconfig.json
npm --prefix worker test
npm --prefix worker run typecheck
```

Measure actual page counts, extraction duration and text quality on representative
scans before estimating cost or increasing limits. Containers bill active CPU and
provisioned memory/disk while awake; do not leave a warm instance running idle.
