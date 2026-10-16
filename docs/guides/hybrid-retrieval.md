# Hybrid retrieval for private dossiers

The dossier assistant can combine lexical search over the extracted evidence
with dense vector search in Cloudflare Vectorize. This is an optional SECOP
backend capability. The current document inventory, extraction, and OCR flow
continues to produce the canonical evidence; embeddings are an additional
retrieval index and never replace those source records.

## Index and model

Use BGE-M3 embeddings with 1024 dimensions and cosine distance. The Vectorize
index is an existing external resource named `secop-dossier-evidence`; OpenTofu
only adds a binding to that index and does not create, replace, or delete it.
The retrieval module uses the Worker AI binding directly with
`@cf/baai/bge-m3`; no separate inference adapter is needed.

Provision the index and its string metadata indexes before any vector is
inserted. From `worker/`, using the repository's Wrangler installation:

```sh
./node_modules/.bin/wrangler vectorize create secop-dossier-evidence --dimensions=1024 --metric=cosine
./node_modules/.bin/wrangler vectorize create-metadata-index secop-dossier-evidence --propertyName=ownerScope --type=string
./node_modules/.bin/wrangler vectorize create-metadata-index secop-dossier-evidence --propertyName=tenderScope --type=string
./node_modules/.bin/wrangler vectorize create-metadata-index secop-dossier-evidence --propertyName=generation --type=string
```

These are Cloudflare's current Wrangler commands for creating an index and
metadata indexes. See [Vectorize Wrangler commands](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/),
[metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/),
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

For OpenTofu, set `dossier_vector_index_name = "secop-dossier-evidence"` and
enable dossiers. An empty name (the default) omits `DOSSIER_VECTORS`, preserving
deployments that do not have a Vectorize index. For local Wrangler use, the
optional equivalent is shown commented in `worker/wrangler.toml` under
`env.dossier`:

```toml
[[env.dossier.vectorize]]
binding = "DOSSIER_VECTORS"
index_name = "secop-dossier-evidence"
```

## Isolation and freshness

Never put a raw owner, dossier, or corpus identifier in a Vectorize namespace,
vector ID, or metadata value. Derive the namespace as the 64-character
hexadecimal SHA-256 of a canonical, unambiguous encoding of the authenticated
owner ID, dossier ID, and canonical corpus revision. Keep the separate
`ownerScope`, `tenderScope`, and `generation` metadata values as SHA-256
hexadecimal strings too: respectively hash the authenticated owner, the owner
and dossier pair, and the canonical source/corpus generation. The metadata
indexes above must exist before inserting vectors. Apply all three metadata
filters and the namespace on every vector query.

Index only chunks from the current canonical evidence. Use deterministic vector
IDs derived from the current namespace and stable chunk identity, so retries
are idempotent. The namespace and IDs change when source versions or canonical
corpus content change. Index lazily in bounded batches and checkpoint progress
in the existing owner-scoped D1 report records; do not add a new public API or
Savia core dependency for indexing. Pending work must remain visible and
resumable.

Each chat advances at most four batches of 16 fragments. Embedding calls have a
separate limit of 1,000 calls per owner per day. Retrieval scans at most 1,000
source chunks and supplies at most ten tender sources to the existing context
budget. These limits are reported in the stored chat retrieval metadata.
Indexing progress uses revision-checked writes so simultaneous chats cannot
move a checkpoint backwards or overwrite progress for a newer dossier revision.

An accepted upsert is not proof that its vectors are searchable. Completion
checks the processed mutation cursor, or verifies submitted vector IDs when
another tenant's mutation has advanced that shared cursor. Visibility checks
remain bounded and refresh the job lease. A large or still-pending index stays
explicitly partial; indexing completeness does not mean a top-k answer reviewed
every requirement.

Vector matches are candidate locations only. Resolve every result back to the
current authorized D1/R2 evidence and confirm its document version, corpus
generation, page/section and exact excerpt before returning it or citing it.
Do not treat Vectorize metadata or stored vector text as evidence. A stale or
unresolvable vector result is discarded.

## Query behavior and retention

Run lexical and vector retrieval over the same authorized current corpus, then
combine ranked results with reciprocal rank fusion (RRF). Apply the owner,
tender and generation filters before accepting vector results. Keep the number
of candidate chunks and the final context size capped; citation verification
does not expand the context limit.

The lexical path uses BM25/IDF with Spanish function-word filtering and bounded
procurement terminology expansion (for example, `trayectoria` and `experiencia`,
or `constancias` and `certificaciones`). The expanded query also drives semantic
retrieval. Direct ranked hits are selected before neighboring source chunks so
adjacent context cannot displace the principal evidence. An uncited answer
marked insufficient evidence is normalized to a retrieval limitation; it must
not assert that the tender does not contain the requested requirement.

If indexing is pending or Vectorize fails, return an explicitly marked lexical
degraded result when lexical retrieval is available. Do not retry with an
unfiltered Vectorize query or broaden the candidate set to compensate. If the
lexical path is unavailable too, report retrieval as unavailable rather than
presenting an incomplete result as complete.

When the source version or canonical corpus changes, use a new generation and
namespace. Old namespaces become unreachable through current-corpus retrieval
but remain stored until an administrator applies the configured retention
policy. This change does not perform live cleanup or deletion.

## Answer freshness and pending analysis

The conversation API derives each answer's `stale` flag from its source corpus
revision and selected company revision compared with the current records.
It recalculates this when reading history, including older answers that stored
an incorrect flag, without rewriting their original audit records. A pending
joint report does not make an answer based on current source documents stale.
The separate `analysisPending` flag describes whether joint synthesis is still
needed. Partial coverage and manual OCR review remain separate limitations.

## Complete-corpus conversation answers

Broad native conversation preparation/review questions no longer use top-k
search as their sole answer context. With a current report, every saved requirement
is returned directly after its citations are validated against all current authorized
tender chunks; selected-company evidence stays scoped to that company. Without a current ledger, all authorized chunks
are reviewed in bounded blocks, including sources outside the top ten hits. Focused follow-ups retain isolated hybrid Vectorize
and lexical retrieval, using the compact reference scheme below without silent
context-budget source deletion. Retrieval metadata distinguishes full-corpus
reviews from limited passage selections; a complete index does not mean every
requirement was reviewed for a focused question.

Citation schemas use short per-request span references instead of embedding repeated
copies of source text in schema enums. Markers partition every character of the
original source text; no text is omitted between markers. The model selects a
supporting reference, and the server attaches the exact original quotation and
document/page. The model does not generate quotation text. Invented references
are rejected. Source text and citation schemas therefore do not duplicate the
entire corpus, and paraphrased quotations cannot trigger recurring retries. Historical answer excerpts are excluded
from factual context because an earlier retrieval error must not become evidence.

The 48,000-character input bound remains below the deployed model's configured
50,000-character limit. Large corpora are read in complete bounded blocks, at most
two concurrently, followed by synthesis from validated original quotations and
block findings. No source is silently dropped to meet a context bound. A source,
resulting synthesis or corpus exceeding operational limits fails explicitly;
there is no truncated-success fallback. Each request records full-corpus source
counts. This means all extracted text was supplied for review, not that OCR is
verified or that the LLM guarantees every legal interpretation. Explicit exhaustive
checklists still use the complete validated saved requirement ledger.

The native provider reads all pages of its selected conversation for transcript
copying, guarded at 1,000 turns and the existing 900 KB serialized response bound.
A changed revision or oversized history fails explicitly rather than exporting an
incomplete transcript. Other tenders, companies, owners and conversations are
never joined to fill context or history.

Broad preparation questions with a current requirement ledger return the complete
server-rendered cited inventory directly. Live testing showed that even a structured
LLM pass over all rows could omit documents or overlook elapsed dates. The inventory
therefore does not pass through another lossy summary; past submission deadlines
are highlighted from validated extracted deadline fields. Focused follow-up questions
still use scoped hybrid retrieval. This avoids extra synthesis latency while preserving
every saved requirement, duplicate and conditional wording for review.
