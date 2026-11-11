# 01: Alert on failed streaming batches

**What to build:** When the OpenSearch streaming function gives up on a batch (after its 3 retries and batch bisection), the batch's failure record lands in the streaming failures queue and nothing tells anyone. Make that loud: every environment gets an SNS alert topic, and an alarm on the failure queue notifies the topic when a failure arrives and again when the queue has been purged.

Decisions already made:

- One SNS topic per environment, created by the Api stack. Its ARN is a stack output so people can add subscriptions (email, Slack/Chatbot) without a code change.
- Environment config gains an optional `alertEmails: string[]`. It is empty for every environment for now; feature (`f-*`) environments get the topic and alarm but never subscribers. Addresses, when added, should be team/list addresses, never personal ones.
- Alarm: queue `ApproximateNumberOfMessagesVisible >= 1` over one 5-minute period, missing data treated as not breaching, both ALARM and OK actions publish to the topic. The alarm stays in ALARM until the queue is drained or purged, so purging is the "resolved" step.
- No alarm on the Lambda's `Errors` metric: transient errors during retries are noise; a queue message is the actionable signal.

Start the operations runbook (`docs/opensearch-streaming.md`) with two sections: **How streaming works** (tables → stream → function → `_bulk`, and the retry / bisect / failure-queue path) and **Alerting** (the topic, the alarm, how to subscribe, what ALARM and OK mean).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Each environment's Api stack creates an SNS topic and outputs its ARN
- [ ] `alertEmails` is accepted in environment config, defaults to empty, and each address becomes an email subscription on the topic
- [ ] An alarm on the failure queue fires at >= 1 visible message over 5 minutes, treats missing data as not breaching, and sends both ALARM and OK to the topic
- [ ] CDK assertion tests cover the topic, output, alarm thresholds/actions, and subscriptions (present when configured, absent when empty)
- [ ] `docs/opensearch-streaming.md` exists with the "How streaming works" and "Alerting" sections
- [ ] Verified on a feature environment: sending a test message to the queue moves the alarm to ALARM; purging returns it to OK
