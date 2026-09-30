"""CloudFormation custom resource that installs an index template on the domain.

Each searchable model gets its own template, named after the resource's
`TemplateName`, which sets the explicit field mappings for that model's index
and `auto_expand_replicas` so a single-node domain runs with 0 replicas
(green) and a multi-node domain gets 1 replica. Templates apply only when an
index is created, so an index that already exists keeps its mappings.
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

# Above the priority-0 `dlpnext-defaults` template this resource used to
# install, so both can briefly coexist while CloudFormation replaces it.
PRIORITY = 1


def _request(method, path, body=None, allow_missing=False):
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
    if allow_missing and res.status_code == 404:
        return None
    if not 200 <= res.status_code <= 299:
        raise RuntimeError(f'{method} {path} failed: {res.status_code} {res.content!r}')
    return res.content


def on_event(event, context):
    logger.info('Event: %s', json.dumps(event))
    props = event['ResourceProperties']
    if event['RequestType'] == 'Delete':
        # Also removes templates whose name changed on an update, since
        # CloudFormation deletes the old physical ID after the new one exists.
        _request('DELETE', f"/_index_template/{event['PhysicalResourceId']}", allow_missing=True)
        return {'PhysicalResourceId': event['PhysicalResourceId']}
    name = props['TemplateName']
    _request('PUT', f'/_index_template/{name}', {
        'index_patterns': props['IndexPatterns'],
        'priority': PRIORITY,
        'template': {
            'settings': {'index.auto_expand_replicas': '0-1'},
            # A JSON string, because CloudFormation turns the numbers and
            # booleans in custom resource properties into strings.
            'mappings': json.loads(props['Mappings']),
        },
    })
    return {'PhysicalResourceId': name}
