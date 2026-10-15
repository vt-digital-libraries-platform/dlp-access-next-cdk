# 01: The streaming handler fails the batch when OpenSearch rejects documents or stays unavailable

**What to build:** When OpenSearch rejects an Archive or Collection change, the change must not disappear silently. Today the streaming handler only logs per-document failures in a bulk response with `errors: true`. It never even logs failed `delete` actions, because the error filter looks only under the `index` key. And it returns normally once its 5xx retries run out, so the stream checkpoint advances and up to a whole batch of changes is lost. In each of these cases the handler should raise. The event source mapping can then retry, bisect the batch, and send records that still fail to the `OpenSearchStreamingFailureQueueUrl` queue, as CLAUDE.md says it does. A delete whose target document is already gone (`not_found`) still counts as success.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Confirm each of the three behaviours in the current handler before changing it
- [ ] A bulk response with any failed `index` item raises, and the error names the failing document ids and reasons
- [ ] A bulk response with any failed `delete` item other than `not_found` raises, and the failure is logged
- [ ] A `delete` that returns `not_found` is treated as success
- [ ] Running out of 5xx retries raises instead of returning
- [ ] pytest cases cover each path (`npm run test:lambda` passes)
- [ ] CLAUDE.md's "Streaming failures" section still matches the behaviour
