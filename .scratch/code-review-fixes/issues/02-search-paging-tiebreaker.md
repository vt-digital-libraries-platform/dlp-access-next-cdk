# 02: Search paging no longer skips documents that share a sort value

**What to build:** Paging through `fulltextArchives`, `fulltextCollections` or `searchObjects` returns every matching document exactly once, even when documents share a sort value. Today `search_after` sorts on a single field with no tiebreaker. Documents that tie at a page boundary are skipped, for example several items titled "Untitled". With a date sort, every document missing a date is lost after the first page, because they all share the same sentinel. Add a unique secondary sort on `id`, and make the page token carry both values. Paging by both keyword and numeric (date/boolean) sort fields must keep working.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Confirm the skip with a sort field that has duplicate values across a page boundary
- [ ] Every search query's sort includes an `id` tiebreaker after the requested field
- [ ] Page tokens round-trip both the sort value and the `id`, for keyword and numeric sort fields
- [ ] Paging a date sort that includes documents with no date returns all of them
- [ ] Jest assertions on the generated resolver code cover the tiebreaker and the token shape (`npm test` passes)
- [ ] CLAUDE.md's paging note is updated
