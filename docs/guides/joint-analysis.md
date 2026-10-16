# Complete joint dossier analysis

Joint analysis runs in the private SECOP backend; Savia consumes the existing
report contract. It does not add tender-specific logic to the Savia platform.

Extraction still visits every document fragment. Validated extraction results are
cached by source content and model, so retries reuse that work without changing
stored requirement wording, IDs or source quotations. Pending and review-required
document coverage remains visible; a completed synthesis does not certify OCR.

The joint comparison uses a lossless requirement table: full wording, category,
mandatory status, lot, deadline, rule and references to a shared source index.
Repeated quotations are not copied into every comparison. All requirements fit
one request when possible. Larger corpora use bounded blocks covering every
unordered requirement pair; oversized individual inputs fail explicitly rather
than truncate. Request sizing includes instructions and the output schema.

Proposed conflicts and amendments receive a separate evidence check using both
original requirements and their complete cited quotations. Confirmed findings
must cite evidence from both sides. Amendments require explicit direction and a
verbatim passage from the replacement source containing explicit change language.
Missing change evidence downgrades the proposal to unconfirmed; added detail and
chronology alone are insufficient. The report retains the individual requirements, original
citations, candidate decisions and document coverage for review.

Each comparison and verification is cached only after validation. Keys include
the model, complete input, coverage, instructions and schema. Progress checkpoints
and cached results permit interrupted jobs to resume. Model, request, job and
spending limits continue to apply. Compact comparison reduces repeated input; it
does not guarantee that a language model finds every semantic issue. Users must
review OCR warnings and the original tender documents before applying.

The report `analysis` field records requirement/document counts, visited extraction
fragments, cache hits, comparison groups, pair coverage and model request counts.
These metrics distinguish work reused from new inference requests.
