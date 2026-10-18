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
citations, candidate decisions and document coverage for review. An unconfirmed
candidate may retain an empty citation list; it is not promoted to a sourced
conflict. Confirmed findings still require validated evidence from both sides.

Each comparison and verification is cached only after validation. Keys include
the model, complete input, coverage, instructions and schema. Progress checkpoints
and cached results permit interrupted jobs to resume. Model, request, job and
spending limits continue to apply. Compact comparison reduces repeated input; it
does not guarantee that a language model finds every semantic issue. Users must
review OCR warnings and the original tender documents before applying.

The report `analysis` field records requirement/document counts, visited extraction
fragments, cache hits, comparison groups, pair coverage and model request counts.
These metrics distinguish work reused from new inference requests.

## Bounded database work

Synthesis preloads validated extraction/comparison cache records in owner-scoped
batches and still selects entries by the exact existing content hash. Final
requirement writes use bounded revision-checked batches. Cached progress is
persisted every twenty completed comparisons and at phase completion; model calls
retain their lease heartbeats. Company evaluation reads the full requirement
index in batches, and profiles without extracted supporting evidence skip model
and cache lookups that cannot establish compliance. These changes retain every
requirement while avoiding thousands of individual D1 round trips per attempt.

## Large aggregate persistence

A complete report can exceed the size of any individual model response. The
aggregate comparison limit is 20 million characters; each inference keeps its
existing bounded input and validated output schema. Exceeding the aggregate
capacity fails explicitly with `REPORT_CAPACITY_LIMIT`, never by clipping
requirements or classifying a complete collection as a truncated inference.

Report, company-assessment and chat-message records larger than 500,000 serialized characters
are stored as immutable, content-addressed JSON objects in the existing private
R2 bucket, with a versioned reference in the owner-scoped D1 record. The complete
UTF-8 object is bounded to 20 MB. Repository reads hydrate and verify its size and
SHA-256 before returning the existing record shape. Missing or corrupt objects
fail closed. Small records remain inline, optimistic revisions still apply, and
other record kinds retain the existing size limit. Conversation turns keep their
atomic revision and pending-request checks when storing a large message. The
complete checklist has a separate 20-million-character output bound; oversized
output fails explicitly. No existing resource or data
migration is required.

## Savia assistant presentation

The adapter keeps the host's existing message, citation and task-suggestion
contracts. When more than 1,000 task suggestions are needed, it groups at most
ten original requirements per suggested task, retaining every wording, reference,
category and citation. Each description remains below 20,000 characters. The
complete individual checklist is still displayed, with a grouping notice.
Identical unsupported-company findings can share a concise summary; the full
individual findings remain in the saved assessment. No company assertion becomes
evidence. The complete adapter response is bounded to 1.9 MB and fails explicitly
rather than silently clipping history or sources.

## Complete checklist questions

Explicit requests for all requirements use the complete saved requirement index,
not top-k retrieval. Each requirement is loaded, scope/revision checked and linked
to an exact current source excerpt. The response preserves duplicates, original
wording and extracted classifications; it does not turn those classifications into
verified eligibility decisions. Pending/OCR review and company evidence gaps are
shown before the list. Oversized output fails explicitly without clipping.

Focused questions continue to use scoped hybrid retrieval. The complete checklist
is an inventory of the saved extraction, not proof that OCR or model extraction
found every obligation in the originals. Review the sources before applying.

Savia's generic external assistant provider uses a private declared action to load,
send and poll the existing conversation. The SECOP service validates the owner,
dossier, company, conversation and job context. No credentials reach the browser;
report completion and pending source review are separate states.
