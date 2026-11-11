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

### Racing the live stream

Writes are last-writer-wins. If an item changes while a resync of it is in flight, the resync can land after the stream's update and put the older version back. The window is a few seconds per batch. Run resyncs at a quiet time, and if in doubt, run the resync again for the affected IDs.
