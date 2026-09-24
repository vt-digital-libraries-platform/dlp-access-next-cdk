"""CloudFormation custom resource that installs an index template on the domain.

Indices are still created on first write with dynamic mapping, as in Amplify.
The template only sets `auto_expand_replicas` so a single-node domain runs
with 0 replicas (green) and a multi-node domain gets 1 replica.
"""
import json
import logging
import os

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.httpsession import URLLib3Session
from botocore.session import Session

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TEMPLATE_NAME = 'dlpnext-defaults'


def _request(method, path, body=None):
    endpoint = os.environ['OPENSEARCH_ENDPOINT']
    region = os.environ['OPENSEARCH_REGION']
    req = AWSRequest(
        method=method,
        url=f'https://{endpoint}{path}',
        data=json.dumps(body) if body is not None else None,
        headers={'Host': endpoint, 'Content-Type': 'application/json'},
    )
    SigV4Auth(Session().get_credentials(), 'es', region).add_auth(req)
    res = URLLib3Session().send(req.prepare())
    if not 200 <= res.status_code <= 299:
        raise RuntimeError(f'{method} {path} failed: {res.status_code} {res.content!r}')
    return res.content


def on_event(event, context):
    logger.info('Event: %s', json.dumps(event))
    if event['RequestType'] in ('Create', 'Update'):
        index_patterns = event['ResourceProperties']['IndexPatterns']
        _request('PUT', f'/_index_template/{TEMPLATE_NAME}', {
            'index_patterns': index_patterns,
            'template': {'settings': {'index.auto_expand_replicas': '0-1'}},
        })
    # On Delete the template goes away with the domain (or is harmless if the
    # domain is retained), so there is nothing to undo.
    return {'PhysicalResourceId': TEMPLATE_NAME}
