# 04: Failed-batch recovery runbook

**What to build:** Someone who receives the streaming-failure alarm can follow a single documented procedure from alert to resolution without prior knowledge of the system. This answers the review request to document the notification setup and the retry/recover procedure for failed OpenSearch stream batches.

Add to the runbook:

- **When the alarm fires:**
  1. Read the failure-queue message: which table, the shard and sequence range, and when it happened.
  2. Find the matching error in the streaming function's CloudWatch Logs (the `List of items with errors` line or the traceback) to learn which documents failed and why.
  3. Fix the cause: mapping conflict, bad data, or domain health.
  4. Resync the affected IDs; resync the whole table if the IDs can't be determined.
  5. Purge the queue and confirm the alarm returns to OK.
- **Limitations:** the stream keeps records for 24 hours, so queue messages (kept 14 days) are pointers, not data, and recovery always goes through the table; full-table resync does not remove orphan documents; resync and live stream updates are last-writer-wins.

Link the runbook from the README and from the deployment guide.

**Blocked by:** 01 (Alert on failed streaming batches), 03 (Resync a whole table with paging)

**Status:** ready-for-agent

- [ ] Runbook has "When the alarm fires" and "Limitations" sections as described
- [ ] README and deployment guide link to the runbook
- [ ] Verified on a feature environment: a deliberately failed batch is taken from alarm to OK by following only the runbook
