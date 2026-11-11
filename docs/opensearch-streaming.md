# OpenSearch streaming

How Archive and Collection changes reach OpenSearch, how you hear when they don't, and how to recover.

## How streaming works

Each environment's `DlpAccessNext-<env>-Api` stack runs the streaming function (`OpenSearchStreamingFunction`). It reads the DynamoDB streams of the `Archive-dlpnext-<env>` and `Collection-dlpnext-<env>` tables and posts each change to the OpenSearch `_bulk` API:

- `INSERT` and `MODIFY` index the item into the index named after the table (`archive` or `collection`), with the derived `date_range` field added.
- `REMOVE` deletes the document.

The stream is read in batches of up to 100 records. A batch fails if OpenSearch rejects the request, keeps returning 5xx after the function's own backoff retries, or reports an error for any item in the batch. A failed batch is handled by the event source mapping:

1. It is retried up to 3 times.
2. On each retry it is split in half (`bisectBatchOnError`), so a single bad record ends up isolated from the good ones, which get indexed.
3. When retries run out, a failure record is sent to the `OpenSearchStreamingFailures` SQS queue (URL in the stack output `OpenSearchStreamingFailureQueueUrl`), kept for 14 days, and the stream moves on.

The failure record describes the batch (table stream ARN, shard, first and last sequence numbers, time). It does **not** contain the records themselves. See [Limitations](#limitations).

## Alerting

Each environment has an SNS topic for streaming alerts. Its ARN is the stack output `StreamingAlertTopicArn`.

The alarm `OpenSearchStreamingFailureAlarm` watches the failure queue. It goes to:

- **ALARM** when at least one message is visible on the queue during a 5-minute period. At least one batch was given up on, and OpenSearch is missing or out of date for some documents until someone recovers it.
- **OK** when the queue is empty again. Purging the queue is the last step of recovery, so OK means someone has finished recovering.

Both transitions are published to the topic. The alarm does not clear on its own: it stays in ALARM until the queue is drained or purged.

### Subscribing

- **Email, managed in code:** add addresses to `alertEmails` for the environment in `infra/lib/config/environments.ts` and deploy. Use a team or list address, not a personal one. AWS sends each address a confirmation email that has to be accepted once. Feature (`f-*`) environments have no subscribers.
- **Anything else** (an extra email, AWS Chatbot for Slack, etc.): subscribe to the topic ARN from the console or CLI. These subscriptions live outside CDK and survive deploys.

```sh
aws sns subscribe --topic-arn <StreamingAlertTopicArn> --protocol email --notification-endpoint <address>
```

## When the alarm fires

The goal is to find out which documents failed and why, fix the cause, re-index them from the table, and clear the queue. You need AWS CLI access to the environment's account. `<env>` is the environment named in the alarm, and the queue URL is the `OpenSearchStreamingFailureQueueUrl` output of `DlpAccessNext-<env>-Api`.

### 1. Read the failure records

```sh
aws sqs receive-message --queue-url <queue URL> \
  --max-number-of-messages 10 --visibility-timeout 0
```

`--visibility-timeout 0` leaves the messages on the queue (and the alarm in ALARM) while you work. Each message body looks like this:

```json
{
  "requestContext": {
    "condition": "RetryAttemptsExhausted",
    "functionArn": "...",
    "approximateInvokeCount": 4
  },
  "responseContext": { "functionError": "Unhandled" },
  "timestamp": "2026-11-11T14:02:31.000Z",
  "DDBStreamBatchInfo": {
    "streamArn": "arn:aws:dynamodb:us-east-1:...:table/Archive-dlpnext-dev/stream/...",
    "shardId": "shardId-...",
    "startSequenceNumber": "...",
    "endSequenceNumber": "...",
    "approximateArrivalOfFirstRecord": "2026-11-11T14:01:58.000Z",
    "approximateArrivalOfLastRecord": "2026-11-11T14:01:58.000Z",
    "batchSize": 1
  }
}
```

Note the **table** (in `streamArn`), the **arrival times** and `batchSize`. Bisection usually narrows a failure down to one or a few records.

### 2. Find the error in the logs

The streaming function's log group is `/aws/lambda/<function name>`. Find the function name with:

```sh
aws lambda list-functions \
  --query "Functions[?contains(FunctionName, 'OpenSearchStreamingFunction')].FunctionName"
```

In CloudWatch Logs Insights, query that log group over a window starting at `approximateArrivalOfFirstRecord` and ending at the message's `timestamp`:

```
fields @timestamp, @message
| filter @message like /List of items with errors|Searchable_Exception|Traceback/
| sort @timestamp asc
```

- **`List of items with errors`**: OpenSearch accepted the request but rejected some documents. The line lists each failed action with its `_index`, `_id` and the `error` (its `type` and `reason`). These are the IDs to resync.
- **`Searchable_Exception: status_code=...`**: OpenSearch rejected the whole request (4xx), or kept failing (5xx). No IDs are logged; the cause is usually the domain (health, storage, access) rather than the data.
- **Any other traceback**: a bug in the handler or an unexpected record shape.

### 3. Fix the cause

Resyncing before fixing the cause fails the same way. Common causes:

- **`mapper_parsing_exception` / `illegal_argument_exception`**: an item has a value the index mapping can't take (wrong type, malformed field). Fix the item in DynamoDB, or fix the mapping in `infra/lib/appsync/search-mappings.ts` and redeploy.
- **`cluster_block_exception`, 429 or 5xx**: the domain is unhealthy, out of storage or overloaded. Check the domain's health and free storage in the OpenSearch console, and resize it through the environment's sizing if needed.
- **403**: the streaming function's IAM grants or the domain's access settings changed. Redeploy the Api stack.

### 4. Resync

- If you have the IDs from step 2, [resync them by ID](#by-id). This also deletes any that were removed from the table.
- If you can't tell which IDs failed (a whole-request failure, or logs already expired), [resync the whole table](#whole-table) named in `streamArn`.

Check the result with a search in the app, or the API's `get` query for an ID.

### 5. Purge the queue

```sh
aws sqs purge-queue --queue-url <queue URL>
```

The alarm returns to OK within about 5 minutes and the topic sends the OK notification. If new messages arrive, start again at step 1.

## Resync reference

The resync function, `dlp-access-next-<env>-opensearch-resync` (stack output `OpenSearchResyncFunctionName`), re-reads items from DynamoDB and indexes them into OpenSearch. It wraps each item as a stream record and runs it through the streaming handler, so documents come out exactly as the stream would have indexed them, `date_range` included.

### By ID

```sh
aws lambda invoke \
  --function-name dlp-access-next-<env>-opensearch-resync \
  --cli-binary-format raw-in-base64-out \
  --payload '{"model": "Archive", "ids": ["<id>", "<id>"]}' \
  /dev/stdout
```

- `model` is `Archive` or `Collection`.
- `ids` is any number of IDs; duplicates are ignored.
- An ID that exists in the table is indexed. An ID that is **no longer in the table is deleted from the index**, which covers a `REMOVE` that never reached OpenSearch.

It returns `{"processed": <number of distinct IDs>, "deleted": [<IDs deleted from the index>]}`. If OpenSearch rejects any document, the invocation fails with the same `List of items with errors` log line the streaming function writes, in the resync function's log group.

### Whole table

Leave out `ids` to resync every item in a table:

```sh
aws lambda invoke \
  --function-name dlp-access-next-<env>-opensearch-resync \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 0 \
  --payload '{"model": "Archive"}' \
  /dev/stdout
```

A Lambda can run for at most 15 minutes, so a run stops starting new pages when about 3 minutes are left and returns `{"processed": <items this run>, "lastEvaluatedKey": <key or null>}`. While `lastEvaluatedKey` is not null, invoke again with it as `startKey`, exactly as returned:

```sh
--payload '{"model": "Archive", "startKey": {"id": {"S": "<id>"}}}'
```

When `lastEvaluatedKey` is null, the whole table has been resynced. `--cli-read-timeout 0` keeps the CLI waiting for a run that takes the full 12 or so minutes.

A full-table resync only indexes what is in the table. It does not remove documents whose items are gone from the table; resync those IDs by ID instead.

### Racing the live stream

Writes are last-writer-wins. If an item changes while a resync of it is in flight, the resync can land after the stream's update and put the older version back. The window is a few seconds per batch. Run resyncs at a quiet time, and if in doubt, run the resync again for the affected IDs.

## Limitations

- **Failure records are pointers, not data.** The queue keeps failure records for 14 days, but they only name a stream sequence range. The stream itself keeps records for 24 hours, so recovery always re-reads the table rather than replaying the stream.
- **No orphan sweep.** A full-table resync indexes what is in the table; it doesn't find documents in OpenSearch whose items are gone. Those are only removed by resyncing their IDs.
- **Last writer wins.** Resyncs and live stream updates aren't ordered against each other. See [Racing the live stream](#racing-the-live-stream).
- **Logs expire.** If the streaming function's logs for a failure are gone, the failed IDs can't be recovered from them; resync the whole table.
