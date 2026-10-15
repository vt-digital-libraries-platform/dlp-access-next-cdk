import importlib
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
os.environ.update({
    'OPENSEARCH_ENDPOINT': 'https://search-dlpnext-dev-abc.us-east-1.es.amazonaws.com',
    'OPENSEARCH_REGION': 'us-east-1',
    'DEBUG': '0',
    'OPENSEARCH_USE_EXTERNAL_VERSIONING': 'false',
})
handler = importlib.import_module('python_streaming_function')

STREAM_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/{table}/stream/2026-09-24T00:00:00.000'


def record(event_name, table, item):
    image = {k: {'S': v} for k, v in item.items()}
    ddb = {'Keys': {'id': image['id']}, 'SequenceNumber': '1'}
    ddb['OldImage' if event_name == 'REMOVE' else 'NewImage'] = image
    return {
        'eventSource': 'aws:dynamodb',
        'eventName': event_name,
        'eventSourceARN': STREAM_ARN.format(table=table),
        'dynamodb': ddb,
    }


@pytest.fixture
def posted(monkeypatch):
    """Captures each bulk request instead of calling OpenSearch."""
    calls = []

    def fake_post(payload, region, creds, host, path, method='POST', proto='https://'):
        calls.append({'host': host, 'path': path, 'lines': [json.loads(l) for l in payload.split('\n') if l]})
        return b'{"errors": false, "took": 1, "items": []}'

    monkeypatch.setattr(handler, 'post_data_to_opensearch', fake_post)
    return calls


def test_insert_indexes_document_into_index_named_after_table(posted):
    item = {'id': 'a1', 'title': 'Map of Blacksburg', 'identifier': 'ark:123'}
    handler.lambda_handler({'Records': [record('INSERT', 'Archive-dlpnext-dev', item)]}, None)

    assert len(posted) == 1
    assert posted[0]['host'] == 'search-dlpnext-dev-abc.us-east-1.es.amazonaws.com'
    assert posted[0]['path'] == '/_bulk'
    action, doc = posted[0]['lines']
    assert action == {'index': {'_index': 'archive', '_id': 'a1'}}
    assert doc == item


def test_indexed_document_gets_a_date_range_from_its_dates(posted):
    item = {'id': 'a1', 'start_date': '1940/06/03', 'end_date': '1949/06/03'}
    handler.lambda_handler({'Records': [record('INSERT', 'Archive-dlpnext-dev', item)]}, None)

    assert posted[0]['lines'][1] == {
        **item,
        'date_range': [{'gte': '1940-06-03T00:00:00.000Z', 'lte': '1949-06-03T23:59:59.999Z'}],
    }


def test_collection_table_goes_to_collection_index(posted):
    handler.lambda_handler(
        {'Records': [record('INSERT', 'Collection-dlpnext-f-search', {'id': 'c1', 'title': 'Letters'})]}, None)

    assert posted[0]['lines'][0] == {'index': {'_index': 'collection', '_id': 'c1'}}


def test_modify_reindexes_and_removes_amplify_legacy_id(posted):
    handler.lambda_handler({'Records': [record('MODIFY', 'Archive-dlpnext-dev', {'id': 'a1', 'title': 'New'})]}, None)

    index_action, doc, legacy_delete = posted[0]['lines']
    assert index_action == {'index': {'_index': 'archive', '_id': 'a1'}}
    assert doc == {'id': 'a1', 'title': 'New'}
    assert legacy_delete == {'delete': {'_index': 'archive', '_id': 'id=a1'}}


def test_remove_deletes_document(posted):
    handler.lambda_handler({'Records': [record('REMOVE', 'Archive-dlpnext-dev', {'id': 'a1', 'title': 'Old'})]}, None)

    assert posted[0]['lines'] == [{'delete': {'_index': 'archive', '_id': 'a1'}}]


def test_no_action_carries_a_mapping_type(posted):
    records = [
        record('INSERT', 'Archive-dlpnext-dev', {'id': 'a1'}),
        record('MODIFY', 'Archive-dlpnext-dev', {'id': 'a2'}),
        record('REMOVE', 'Archive-dlpnext-dev', {'id': 'a3'}),
    ]
    handler.lambda_handler({'Records': records}, None)

    for line in posted[0]['lines']:
        for action in ('index', 'delete'):
            if action in line:
                assert '_type' not in line[action]


def test_batch_with_nothing_to_send_makes_no_request(posted):
    handler.lambda_handler({'Records': [{'eventSource': 'aws:sqs'}]}, None)

    assert posted == []


def test_failed_request_is_raised_so_the_stream_retries(monkeypatch):
    def failing_post(*args, **kwargs):
        raise handler.Searchable_Exception(403, b'forbidden')

    monkeypatch.setattr(handler, 'post_data_to_opensearch', failing_post)

    with pytest.raises(handler.Searchable_Exception):
        handler.lambda_handler({'Records': [record('INSERT', 'Archive-dlpnext-dev', {'id': 'a1'})]}, None)


def bulk_response(*items):
    """A bulk response body whose errors flag is set as OpenSearch sets it."""
    return json.dumps({
        'took': 1,
        'errors': any('error' in result for item in items for result in item.values()),
        'items': list(items),
    }).encode()


def respond_with(monkeypatch, *bodies):
    """Answers successive bulk requests with the given bodies or exceptions."""
    responses = iter(bodies)

    def fake_post(*args, **kwargs):
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(handler, 'post_data_to_opensearch', fake_post)


def test_rejected_index_item_is_raised_with_its_id_and_reason(monkeypatch):
    respond_with(monkeypatch, bulk_response(
        {'index': {'_index': 'archive', '_id': 'a1', 'status': 201, 'result': 'created'}},
        {'index': {'_index': 'archive', '_id': 'a2', 'status': 400, 'error': {
            'type': 'mapper_parsing_exception', 'reason': 'failed to parse field [start_date]'}}},
    ))
    records = [record('INSERT', 'Archive-dlpnext-dev', {'id': 'a1'}),
               record('INSERT', 'Archive-dlpnext-dev', {'id': 'a2'})]

    with pytest.raises(handler.Bulk_Exception) as raised:
        handler.lambda_handler({'Records': records}, None)

    message = str(raised.value)
    assert 'a2' in message
    assert 'failed to parse field [start_date]' in message
    assert 'a1' not in message


def test_rejected_delete_item_is_logged_and_raised(monkeypatch, caplog):
    respond_with(monkeypatch, bulk_response(
        {'delete': {'_index': 'archive', '_id': 'a1', 'status': 429, 'error': {
            'type': 'es_rejected_execution_exception', 'reason': 'rejected execution'}}},
    ))

    with pytest.raises(handler.Bulk_Exception) as raised:
        handler.lambda_handler({'Records': [record('REMOVE', 'Archive-dlpnext-dev', {'id': 'a1'})]}, None)

    assert 'a1' in str(raised.value)
    assert 'rejected execution' in caplog.text


def test_delete_of_a_missing_document_succeeds(monkeypatch):
    respond_with(monkeypatch, bulk_response(
        {'index': {'_index': 'archive', '_id': 'a1', 'status': 200, 'result': 'updated'}},
        {'delete': {'_index': 'archive', '_id': 'id=a1', 'status': 404, 'result': 'not_found'}},
    ))

    handler.lambda_handler({'Records': [record('MODIFY', 'Archive-dlpnext-dev', {'id': 'a1'})]}, None)


def test_delete_not_found_reported_as_an_error_still_succeeds(monkeypatch):
    respond_with(monkeypatch, bulk_response(
        {'delete': {'_index': 'archive', '_id': 'a1', 'status': 404, 'result': 'not_found',
                    'error': {'type': 'document_missing_exception', 'reason': 'not found'}}},
    ))

    handler.lambda_handler({'Records': [record('REMOVE', 'Archive-dlpnext-dev', {'id': 'a1'})]}, None)


def test_server_error_is_retried(monkeypatch):
    monkeypatch.setattr(handler.time, 'sleep', lambda seconds: None)
    respond_with(monkeypatch,
                 handler.Searchable_Exception(503, b'unavailable'),
                 bulk_response({'index': {'_index': 'archive', '_id': 'a1', 'status': 201, 'result': 'created'}}))

    handler.lambda_handler({'Records': [record('INSERT', 'Archive-dlpnext-dev', {'id': 'a1'})]}, None)


def test_running_out_of_server_error_retries_is_raised(monkeypatch):
    monkeypatch.setattr(handler.time, 'sleep', lambda seconds: None)
    respond_with(monkeypatch, *[handler.Searchable_Exception(503, b'unavailable')] * handler.OPENSEARCH_MAX_RETRIES)

    with pytest.raises(handler.Searchable_Exception) as raised:
        handler.lambda_handler({'Records': [record('INSERT', 'Archive-dlpnext-dev', {'id': 'a1'})]}, None)

    assert raised.value.status_code == 503
