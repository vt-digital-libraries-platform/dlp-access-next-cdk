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
