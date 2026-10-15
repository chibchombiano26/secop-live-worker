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

Docker must be running. From the repository root:

```sh
worker/node_modules/.bin/wrangler deploy --config ocr/wrangler.jsonc
```

Deploy the SECOP Worker with this additive service binding, preserving all
existing OAuth/catalog/D1/R2/queue bindings and secrets:

```json
{"services":[{"binding":"SECOP_OCR","service":"secop-cpu-ocr"}]}
```

For OpenTofu deployments set `enable_dossiers=true` and
`ocr_worker_service="secop-cpu-ocr"`; the container service itself is deployed by
Wrangler. Do not replace an existing deployment with placeholder resource IDs.
Removing the binding restores native extraction without deleting originals.

## Behavior and limits

Readable files stay on the existing extractor. PDF extraction that yields no
text or empty pages falls back to CPU OCR. An explicitly configured external
`EXTRACTOR_URL` still takes precedence. Other file types remain on the existing
extractor. Original files stay private in R2; temporary container files are
removed after each request. OCR results preserve 1-based page numbers.

The first version accepts PDFs up to 25 MiB and 20 pages, processes one request
at a time, and enforces an 80-second subprocess deadline. Busy/startup failures
are retryable; oversized, encrypted, invalid or timed-out documents remain
explicit failures rather than partial successful extractions. Larger documents
need a later durable page-batch implementation or an external extractor.

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
