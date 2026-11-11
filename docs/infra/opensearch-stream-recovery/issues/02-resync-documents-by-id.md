# 02: Resync documents by ID

**What to build:** An operator can bring specific Archive or Collection documents in OpenSearch back in line with DynamoDB by invoking a resync function with a model and a list of IDs. This is the recovery path for failed streaming batches: DynamoDB stream failure records only point at a sequence range (and the stream keeps records for just 24 hours), so the table, not the stream, is the source of truth for recovery.

Decisions already made:

- The resync is a second entry point in the same code asset as the streaming function, deployed as its own Lambda with DynamoDB read on the searchable tables and the same OpenSearch read/write grants the streaming function has. It is invoked with `aws lambda invoke`.
- It must index exactly as the stream does: wrap each item as a synthetic stream `INSERT` record and run it through the existing streaming handler, so the document ID, index name and transforms (including date ranges) cannot drift.
- Payload: `{"model": "Archive" | "Collection", "ids": [...]}`. Reject unknown models and malformed payloads with a clear error.
- An ID that is no longer in the table is deleted from the index (covers a failed `REMOVE` that never reached OpenSearch).
- Last writer wins (external versioning stays off). A resync racing a live stream update can briefly write an older version; the documented answer is "run at a quiet time; re-run for the affected IDs if in doubt", not locking.

Add a **Resync reference** section to the runbook covering the by-ID payload, the invoke command, delete behaviour, and the race note.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A resync function is deployed per environment with DynamoDB read and OpenSearch read/write grants, and nothing broader
- [ ] Invoking it with a model and IDs indexes existing items through the streaming handler's transform
- [ ] IDs missing from the table are deleted from the index
- [ ] Invalid payloads (unknown model, missing/empty `ids` while full-table mode doesn't exist yet, wrong types) fail with a clear message
- [ ] pytest covers index-by-ID, delete-missing-ID, and payload validation
- [ ] CDK assertion tests cover the function and its grants
- [ ] Runbook has a "Resync reference" section for the by-ID mode, including the race note
- [ ] Verified on a feature environment: a hand-edited OpenSearch document matches the table again after resyncing its ID
