"""A local S3 (moto) that can misbehave on purpose, standing in for Backblaze.

Faults are set live with  POST /__faults  {"UploadPart": {"fail": 0.25, "delay": 0.1, "delay_s": 3}, ...}
Operation names: CreateMultipartUpload, UploadPart, ListParts, CompleteMultipartUpload,
PutObject, GetObject, HeadObject, ListObjectsV2.  "fail_next": N fails the next N calls.
GET /__stats returns call and fault counts per operation.

Usage: python3 faulty_s3.py PORT
"""
import json
import random
import sys
import threading
import time
from urllib.parse import parse_qs

from moto.server import DomainDispatcherApplication, create_backend_app
from werkzeug.serving import run_simple

LOCK = threading.Lock()
FAULTS = {}
STATS = {}


def op_name(environ):
    method = environ['REQUEST_METHOD']
    qs = parse_qs(environ.get('QUERY_STRING', ''), keep_blank_values=True)
    path = environ.get('PATH_INFO', '/')
    has_key = path.count('/') >= 2 and path.split('/', 2)[2] != ''
    if method == 'POST' and 'uploads' in qs:
        return 'CreateMultipartUpload'
    if method == 'PUT' and 'partNumber' in qs:
        return 'UploadPart'
    if method == 'GET' and 'uploadId' in qs:
        return 'ListParts'
    if method == 'POST' and 'uploadId' in qs:
        return 'CompleteMultipartUpload'
    if method == 'DELETE' and 'uploadId' in qs:
        return 'AbortMultipartUpload'
    if method == 'PUT' and has_key:
        return 'PutObject'
    if method == 'GET' and has_key:
        return 'GetObject'
    if method == 'HEAD' and has_key:
        return 'HeadObject'
    if method == 'GET':
        return 'ListObjectsV2'
    return method


class Faulty:
    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '')
        if path == '/__faults' and environ['REQUEST_METHOD'] == 'POST':
            body = environ['wsgi.input'].read(int(environ.get('CONTENT_LENGTH') or 0))
            with LOCK:
                FAULTS.clear()
                FAULTS.update(json.loads(body or b'{}'))
            start_response('200 OK', [('Content-Type', 'application/json')])
            return [b'{"ok":true}']
        if path == '/__stats':
            with LOCK:
                out = json.dumps(STATS).encode()
            start_response('200 OK', [('Content-Type', 'application/json')])
            return [out]

        op = op_name(environ)
        with LOCK:
            st = STATS.setdefault(op, {'calls': 0, 'failed': 0, 'delayed': 0})
            st['calls'] += 1
            f = dict(FAULTS.get(op, {}))
            fail = False
            if f.get('fail_next', 0) > 0:
                FAULTS[op]['fail_next'] -= 1
                fail = True
            elif random.random() < f.get('fail', 0):
                fail = True
            delay = f.get('delay_s', 0) if random.random() < f.get('delay', 0) else 0
            if fail:
                st['failed'] += 1
            if delay:
                st['delayed'] += 1
        if delay:
            time.sleep(delay)
        if fail:
            # Drain the request body so the client sees a clean HTTP error, like B2's 503.
            try:
                environ['wsgi.input'].read(int(environ.get('CONTENT_LENGTH') or 0))
            except Exception:
                pass
            start_response('503 Service Unavailable', [('Content-Type', 'application/xml')])
            return [b'<?xml version="1.0"?><Error><Code>ServiceUnavailable</Code><Message>injected</Message></Error>']
        return self.app(environ, start_response)


if __name__ == '__main__':
    port = int(sys.argv[1])
    app = DomainDispatcherApplication(create_backend_app)
    run_simple('127.0.0.1', port, Faulty(app), threaded=True, use_reloader=False, use_debugger=False)
