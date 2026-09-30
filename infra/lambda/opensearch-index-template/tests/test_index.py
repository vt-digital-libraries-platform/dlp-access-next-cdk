import importlib
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
handler = importlib.import_module('index')

MAPPINGS = {'properties': {'title': {'type': 'text'}, 'visibility': {'type': 'boolean'}}}
PROPS = {
    'TemplateName': 'dlpnext-archive',
    'IndexPatterns': ['archive'],
    'Mappings': json.dumps(MAPPINGS),
}


@pytest.fixture
def calls(monkeypatch):
    recorded = []
    monkeypatch.setattr(handler, '_request', lambda *args, **kwargs: recorded.append((args, kwargs)))
    return recorded


@pytest.mark.parametrize('request_type', ['Create', 'Update'])
def test_puts_the_template_with_the_parsed_mappings(calls, request_type):
    result = handler.on_event({'RequestType': request_type, 'ResourceProperties': PROPS}, None)
    assert result == {'PhysicalResourceId': 'dlpnext-archive'}
    assert calls == [(('PUT', '/_index_template/dlpnext-archive', {
        'index_patterns': ['archive'],
        'priority': 1,
        'template': {
            'settings': {'index.auto_expand_replicas': '0-1'},
            'mappings': MAPPINGS,
        },
    }), {})]


def test_delete_removes_the_template_it_was_created_as(calls):
    # The old single template had no TemplateName property.
    event = {'RequestType': 'Delete', 'PhysicalResourceId': 'dlpnext-defaults',
             'ResourceProperties': {'IndexPatterns': ['archive', 'collection']}}
    assert handler.on_event(event, None) == {'PhysicalResourceId': 'dlpnext-defaults'}
    assert calls == [(('DELETE', '/_index_template/dlpnext-defaults'), {'allow_missing': True})]
