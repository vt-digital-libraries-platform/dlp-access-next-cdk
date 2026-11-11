"""Re-indexes Archive and Collection items from DynamoDB into OpenSearch.

Recovery for batches the streaming function gave up on: the table, not the
stream, is the source of truth. Items are wrapped as stream records and run
through the streaming handler, so they are indexed exactly as the stream
indexes them. See docs/opensearch-streaming.md.
"""
import json
import logging
import os
import time

import boto3

import python_streaming_function as streaming

# Model name -> table name, for the models whose tables stream into OpenSearch
TABLES = json.loads(os.environ['RESYNC_TABLES'])
BATCH_SIZE = 100  # BatchGetItem's key limit, and the stream's batch size
MAX_UNPROCESSED_RETRIES = 8
# A full-table run stops starting new pages with this much of the Lambda's
# 15 minutes left, so a page in flight finishes and the run returns its
# resume key instead of timing out.
RESERVE_MS = 3 * 60 * 1000

logger = logging.getLogger()
dynamodb = boto3.client('dynamodb')


def _stream_record(table, event_name, image):
    image_name = 'OldImage' if event_name == 'REMOVE' else 'NewImage'
    return {
        'eventSource': 'aws:dynamodb',
        'eventName': event_name,
        # The streaming handler only reads the table name from the ARN
        'eventSourceARN': 'arn:aws:dynamodb:::table/{}'.format(table),
        'dynamodb': {'Keys': {'id': image['id']}, image_name: image, 'SequenceNumber': 'resync'},
    }


def _batch_get(table, ids):
    """The items with these IDs, retrying keys DynamoDB leaves unprocessed."""
    items = []
    request = {table: {'Keys': [{'id': {'S': i}} for i in ids]}}
    for attempt in range(MAX_UNPROCESSED_RETRIES + 1):
        response = dynamodb.batch_get_item(RequestItems=request)
        items.extend(response['Responses'].get(table, []))
        request = response.get('UnprocessedKeys') or {}
        if not request:
            return items
        time.sleep(min(2 ** attempt * 0.1, 5))
    raise RuntimeError('DynamoDB left keys unprocessed after {} retries: {}'.format(
        MAX_UNPROCESSED_RETRIES, request))


def _resync_ids(table, ids):
    """Indexes the items with these IDs; deletes IDs no longer in the table."""
    ids = list(dict.fromkeys(ids))  # BatchGetItem rejects duplicate keys
    deleted = []
    for start in range(0, len(ids), BATCH_SIZE):
        batch = ids[start:start + BATCH_SIZE]
        found = {item['id']['S']: item for item in _batch_get(table, batch)}
        deleted.extend(i for i in batch if i not in found)
        records = [
            _stream_record(table, 'INSERT', found[i]) if i in found
            else _stream_record(table, 'REMOVE', {'id': {'S': i}})
            for i in batch
        ]
        streaming._lambda_handler({'Records': records}, None)
    return len(ids), deleted


def _resync_table(table, start_key, context):
    """Indexes every item in the table from start_key, a page at a time.

    Returns the number of items indexed and the key to resume from, which
    is None once the whole table is done.
    """
    processed = 0
    while context.get_remaining_time_in_millis() >= RESERVE_MS:
        scan = {'TableName': table, 'Limit': BATCH_SIZE}
        if start_key:
            scan['ExclusiveStartKey'] = start_key
        page = dynamodb.scan(**scan)
        records = [_stream_record(table, 'INSERT', item) for item in page['Items']]
        if records:
            streaming._lambda_handler({'Records': records}, None)
        processed += len(records)
        start_key = page.get('LastEvaluatedKey')
        if not start_key:
            return processed, None
    return processed, start_key


def _parse(event):
    """The table, IDs and start key to resync, or ValueError naming what is wrong."""
    if not isinstance(event, dict):
        raise ValueError('payload must be a JSON object, like {"model": "Archive", "ids": ["..."]}')
    unknown = sorted(set(event) - {'model', 'ids', 'startKey'})
    if unknown:
        raise ValueError('unknown fields: {}'.format(', '.join(unknown)))
    if event.get('model') not in TABLES:
        raise ValueError('model must be one of {}'.format(', '.join(sorted(TABLES))))
    ids = event.get('ids')
    start_key = event.get('startKey')
    if ids is None:
        if start_key is not None and not isinstance(start_key, dict):
            raise ValueError('startKey must be the lastEvaluatedKey a previous run returned')
        return TABLES[event['model']], None, start_key
    if start_key is not None:
        raise ValueError('startKey only applies without ids, to resume a full-table resync')
    if not (isinstance(ids, list) and ids and all(isinstance(i, str) and i for i in ids)):
        raise ValueError('ids must be a non-empty list of IDs')
    return TABLES[event['model']], ids, None


def lambda_handler(event, context):
    table, ids, start_key = _parse(event)
    if ids is None:
        logger.info('Resyncing %s from %s', table, start_key or 'the start')
        processed, last_key = _resync_table(table, start_key, context)
        logger.info('Resynced %s items; lastEvaluatedKey=%s', processed, last_key)
        return {'processed': processed, 'lastEvaluatedKey': last_key}
    logger.info('Resyncing %s IDs from %s', len(ids), table)
    processed, deleted = _resync_ids(table, ids)
    logger.info('Resynced %s IDs; deleted from the index: %s', processed, deleted)
    return {'processed': processed, 'deleted': deleted}
