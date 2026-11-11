# 03: Resync a whole table with paging

**What to build:** When the affected IDs can't be determined, an operator can resync an entire Archive or Collection table by invoking the resync function without `ids`. Large tables can't finish inside Lambda's 15-minute limit, so a run stops cleanly before the limit and tells the operator where to resume.

Decisions already made:

- Omitting `ids` scans the whole table. Payload gains an optional `startKey` to resume a scan.
- Each invocation stops safely at about 12 minutes and returns `{"processed": <n>, "lastEvaluatedKey": <key or null>}`. The operator re-invokes with `startKey` set to the returned key until it is null. No self-invocation.
- Full-table mode does not sweep orphan documents (in OpenSearch but not in the table); that is a separate tool if drift ever shows up.

Extend the runbook's **Resync reference** with the full-table mode and the resume loop.

**Blocked by:** 02 (Resync documents by ID)

**Status:** done (awaiting on-AWS verification)

- [x] Invoking without `ids` scans the model's table and indexes every item through the streaming handler's transform
- [x] A run stops before ~12 minutes and returns `processed` and `lastEvaluatedKey`; `startKey` resumes from that key; a finished scan returns a null key
- [x] pytest covers a multi-page scan, resuming from `startKey`, and stopping on the time budget
- [x] Runbook "Resync reference" documents full-table mode and how to loop until the key is null
- [ ] Verified on a feature environment: a full resync reports `processed` equal to the table's item count
