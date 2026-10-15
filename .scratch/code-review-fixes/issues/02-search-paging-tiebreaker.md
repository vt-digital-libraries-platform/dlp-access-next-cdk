# 02: Search paging no longer skips documents that share a sort value

**What to build:** Paging through `fulltextArchives`, `fulltextCollections` or `searchObjects` returns every matching document exactly once, even when documents share a sort value. Today `search_after` sorts on a single field with no tiebreaker. Documents that tie at a page boundary are skipped, for example several items titled "Untitled". With a date sort, every document missing a date is lost after the first page, because they all share the same sentinel. Add a unique secondary sort on `id`, and make the page token carry both values. Paging by both keyword and numeric (date/boolean) sort fields must keep working.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Confirm the skip with a sort field that has duplicate values across a page boundary
- [x] Every search query's sort includes an `id` tiebreaker after the requested field
- [x] Page tokens round-trip both the sort value and the `id`, for keyword and numeric sort fields
- [x] Paging a date sort that includes documents with no date returns all of them
- [x] Jest assertions on the generated resolver code cover the tiebreaker and the token shape (`npm test` passes)
- [x] CLAUDE.md's paging note is updated

## Comments

Implemented in a770028 and the follow-up review commit. Sorts end with `id.keyword` (except a sort on `id` itself), and the page token is the last hit's sort values as a JSON array. The skip was confirmed by paging the generated resolver against an in-memory stand-in for OpenSearch's sort and `search_after` in `infra/test/resolvers.test.ts`, not against a real index. A text sort whose last hit has no value used to return a `null` token and end paging; it now pages on.

Not fixed, found in review: in `searchObjects`, sorting on a date or boolean field mapped in only one of the two indices fails with "No mapping found", because the sort has no `unmapped_type`.
