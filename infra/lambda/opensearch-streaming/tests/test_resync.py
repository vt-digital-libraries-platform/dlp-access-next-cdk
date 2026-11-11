import importlib
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
os.environ.update({
    'AWS_DEFAULT_REGION': 'us-east-1',
    'OPENSEARCH_ENDPOINT': 'https://search-dlpnext-dev-abc.us-east-1.es.amazonaws.com',
    'OPENSEARCH_REGION': 'us-east-1',
    'DEBUG': '0',
    'OPENSEARCH_USE_EXTERNAL_VERSIONING': 'false',
    'RESYNC_TABLES': json.dumps({'Archive': 'Archive-dlpnext-dev', 'Collection': 'Collection-dlpnext-dev'}),
})
streaming = importlib.import_module('python_streaming_function')
resync = importlib.import_module('resync')


def typed(item):
    """An item as the low-level DynamoDB API returns it."""
    return {k: {'S': v} for k, v in item.items()}


class FakeDynamoDB:
    """The DynamoDB client calls resync makes, over in-memory tables."""

    def __init__(self, tables, unprocessed_once=()):
        self.tables = {name: [typed(i) for i in items] for name, items in tables.items()}
        # IDs left unprocessed the first time they are asked for, as under throttling
        self.unprocessed_once = set(unprocessed_once)

    def batch_get_item(self, RequestItems):
        (table, request), = RequestItems.items()
        ids = [key['id']['S'] for key in request['Keys']]
        assert len(ids) <= 100 and len(set(ids)) == len(ids), 'DynamoDB rejects this request'
        deferred = [i for i in ids if i in self.unprocessed_once]
        self.unprocessed_once -= set(deferred)
        found = [i for i in self.tables[table] if i['id']['S'] in ids and i['id']['S'] not in deferred]
        unprocessed = {table: {'Keys': [{'id': {'S': i}} for i in deferred]}} if deferred else {}
        return {'Responses': {table: found}, 'UnprocessedKeys': unprocessed}


@pytest.fixture
def posted(monkeypatch):
    """Captures each bulk request instead of calling OpenSearch."""
    calls = []

    def fake_post(payload, region, creds, host, path, method='POST', proto='https://'):
        calls.append([json.loads(l) for l in payload.split('\n') if l])
        return b'{"errors": false, "took": 1, "items": []}'

    monkeypatch.setattr(streaming, 'post_data_to_opensearch', fake_post)
    return calls


@pytest.fixture
def tables(monkeypatch):
    def use(unprocessed_once=(), **tables):
        monkeypatch.setattr(resync, 'dynamodb', FakeDynamoDB(tables, unprocessed_once))
    return use


def bulk_lines(posted):
    return [line for call in posted for line in call]


def test_resyncing_an_id_indexes_the_item_as_the_stream_would(posted, tables):
    item = {'id': 'a1', 'title': 'Map of Blacksburg', 'start_date': '1940/06/03', 'end_date': '1949/06/03'}
    tables(**{'Archive-dlpnext-dev': [item]})

    result = resync.lambda_handler({'model': 'Archive', 'ids': ['a1']}, None)

    assert bulk_lines(posted) == [
        {'index': {'_index': 'archive', '_id': 'a1'}},
        {**item, 'date_range': [{'gte': '1940-06-03T00:00:00.000Z', 'lte': '1949-06-03T23:59:59.999Z'}]},
    ]
    assert result['processed'] == 1


def test_an_id_no_longer_in_the_table_is_deleted_from_the_index(posted, tables):
    tables(**{'Collection-dlpnext-dev': [{'id': 'c1', 'title': 'Letters'}]})

    result = resync.lambda_handler({'model': 'Collection', 'ids': ['c1', 'gone']}, None)

    assert bulk_lines(posted) == [
        {'index': {'_index': 'collection', '_id': 'c1'}},
        {'id': 'c1', 'title': 'Letters'},
        {'delete': {'_index': 'collection', '_id': 'gone'}},
    ]
    assert result == {'processed': 2, 'deleted': ['gone']}


def indexed_ids(posted):
    return [line['index']['_id'] for line in bulk_lines(posted) if 'index' in line]


def test_many_ids_are_resynced_in_batches_within_dynamodb_limits(posted, tables):
    ids = ['a{}'.format(n) for n in range(250)]
    tables(**{'Archive-dlpnext-dev': [{'id': i} for i in ids]})

    result = resync.lambda_handler({'model': 'Archive', 'ids': ids + ['a0', 'a1']}, None)

    assert sorted(indexed_ids(posted)) == sorted(ids)
    assert result == {'processed': 250, 'deleted': []}


def test_ids_dynamodb_leaves_unprocessed_are_retried_not_deleted(posted, tables, monkeypatch):
    monkeypatch.setattr(resync.time, 'sleep', lambda seconds: None)
    tables(unprocessed_once=['a2'], **{'Archive-dlpnext-dev': [{'id': 'a1'}, {'id': 'a2'}]})

    result = resync.lambda_handler({'model': 'Archive', 'ids': ['a1', 'a2']}, None)

    assert sorted(indexed_ids(posted)) == ['a1', 'a2']
    assert result == {'processed': 2, 'deleted': []}


@pytest.mark.parametrize('event, message', [
    ({'ids': ['a1']}, 'model must be one of Archive, Collection'),
    ({'model': 'Partner', 'ids': ['a1']}, 'model must be one of Archive, Collection'),
    ({'model': 'Archive', 'ids': 'a1'}, 'ids must be a non-empty list of IDs'),
    ({'model': 'Archive', 'ids': []}, 'ids must be a non-empty list of IDs'),
    ({'model': 'Archive', 'ids': ['a1', '']}, 'ids must be a non-empty list of IDs'),
    ({'model': 'Archive', 'ids': ['a1', 2]}, 'ids must be a non-empty list of IDs'),
    ({'model': 'Archive', 'ids': ['a1'], 'extra': 1}, 'unknown fields: extra'),
    ('Archive', 'payload must be a JSON object'),
])
def test_invalid_payloads_are_rejected_before_anything_is_touched(posted, tables, event, message):
    tables(**{'Archive-dlpnext-dev': [{'id': 'a1'}]})

    with pytest.raises(ValueError, match=message):
        resync.lambda_handler(event, None)
    assert posted == []
