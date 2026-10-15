# 01: The streaming handler fails the batch when OpenSearch rejects documents or stays unavailable

**What to build:** When OpenSearch rejects an Archive or Collection change, the change must not disappear silently. Today the streaming handler only logs per-document failures in a bulk response with `errors: true`. It never even logs failed `delete` actions, because the error filter looks only under the `index` key. And it returns normally once its 5xx retries run out, so the stream checkpoint advances and up to a whole batch of changes is lost. In each of these cases the handler should raise. The event source mapping can then retry, bisect the batch, and send records that still fail to the `OpenSearchStreamingFailureQueueUrl` queue, as CLAUDE.md says it does. A delete whose target document is already gone (`not_found`) still counts as success.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Confirm each of the three behaviours in the current handler before changing it
- [x] A bulk response with any failed `index` item raises, and the error names the failing document ids and reasons
- [x] A bulk response with any failed `delete` item other than `not_found` raises, and the failure is logged
- [x] A `delete` that returns `not_found` is treated as success
- [x] Running out of 5xx retries raises instead of returning
- [x] pytest cases cover each path (`npm run test:lambda` passes)
- [x] CLAUDE.md's "Streaming failures" section still matches the behaviour

## Comments

Implemented in 694ae36 and the follow-up review commit. The handler raises `Bulk_Exception` for any bulk action with an `error`, and re-raises the last `Searchable_Exception` once 5xx retries run out. A bulk `delete` of a missing document returns `not_found` with no `error`, so it already counts as success.

Open note: if `OPENSEARCH_USE_EXTERNAL_VERSIONING` is ever turned on, a stale record's 409 `version_conflict_engine_exception` would now fail the batch and end up in the failure queue instead of being skipped.
