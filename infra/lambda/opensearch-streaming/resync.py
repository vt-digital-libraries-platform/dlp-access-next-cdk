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


def _parse(event):
    """The table and IDs to resync, or ValueError naming what is wrong."""
    if not isinstance(event, dict):
        raise ValueError('payload must be a JSON object, like {"model": "Archive", "ids": ["..."]}')
    unknown = sorted(set(event) - {'model', 'ids'})
    if unknown:
        raise ValueError('unknown fields: {}'.format(', '.join(unknown)))
    if event.get('model') not in TABLES:
        raise ValueError('model must be one of {}'.format(', '.join(sorted(TABLES))))
    ids = event.get('ids')
    if not (isinstance(ids, list) and ids and all(isinstance(i, str) and i for i in ids)):
        raise ValueError('ids must be a non-empty list of IDs')
    return TABLES[event['model']], ids


def lambda_handler(event, context):
    table, ids = _parse(event)
    logger.info('Resyncing %s IDs from %s', len(ids), table)
    processed, deleted = _resync_ids(table, ids)
    logger.info('Resynced %s IDs; deleted from the index: %s', processed, deleted)
    return {'processed': processed, 'deleted': deleted}
