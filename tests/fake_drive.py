"""A stand-in for Google Drive's API, enough for CamOp's delivery code, with faults on demand.

Implements: service-account token exchange, shared drive listing, folder/file search by
name and parent, folder creation, resumable uploads (chunks, 308 + Range, status queries,
MD5 on completion), media updates and deletes.

Faults (POST /__faults JSON, or FAKE_DRIVE_FAULTS env):
  chunk_fail     chance a chunk gets a 503 and nothing is kept
  chunk_partial  chance only part of a chunk is kept (256 KiB aligned), then 503
  chunk_drop     chance the whole chunk is kept but the connection closes with no answer
  api_fail       chance any metadata call gets a 503
  corrupt        chance a stored chunk has one byte flipped (the MD5 check must catch it)
GET /__dump lists every item with its path, size and MD5.

Usage: python3 fake_drive.py PORT
"""
import hashlib
import json
import os
import random
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

LOCK = threading.Lock()
SHARED = {'id': 'SD1', 'name': 'CamOp Uploads'}
ITEMS = {}      # id -> {id, name, mimeType, parents, data(bytes)|None}
SESSIONS = {}   # upload_id -> {meta, total, data(bytearray), done_id}
FAULTS = json.loads(os.environ.get('FAKE_DRIVE_FAULTS') or '{}')
STATS = {'chunks': 0, 'chunk_fail': 0, 'chunk_partial': 0, 'chunk_drop': 0, 'api_fail': 0, 'uploads_started': 0}
FOLDER = 'application/vnd.google-apps.folder'


def path_of(item):
    parts = [item['name']]
    p = item['parents'][0] if item.get('parents') else None
    while p and p != SHARED['id']:
        it = ITEMS.get(p)
        if not it:
            break
        parts.append(it['name']); p = it['parents'][0] if it.get('parents') else None
    return SHARED['name'] + '/' + '/'.join(reversed(parts))


def public(item):
    out = {'id': item['id'], 'name': item['name'], 'mimeType': item['mimeType'],
           'webViewLink': f"https://drive.google.com/{'drive/folders' if item['mimeType'] == FOLDER else 'file/d'}/{item['id']}"}
    if item.get('data') is not None:
        out['size'] = str(len(item['data'])); out['md5Checksum'] = hashlib.md5(item['data']).hexdigest()
    return out


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, headers=None):
        body = b'' if obj is None else (obj if isinstance(obj, bytes) else json.dumps(obj).encode())
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if obj is not None:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def _authed(self):
        if self.headers.get('Authorization') != 'Bearer fake-token':
            self._body(); self._send(401, {'error': 'unauthorized'}); return False
        return True

    def _maybe_api_fail(self):
        if random.random() < FAULTS.get('api_fail', 0):
            self._body(); STATS['api_fail'] += 1; self._send(503, {'error': 'injected'}); return True
        return False

    # ------------------------------------------------------------------
    def do_POST(self):
        u = urlparse(self.path); qs = parse_qs(u.query)
        if u.path == '/__faults':
            FAULTS.clear(); FAULTS.update(json.loads(self._body() or b'{}')); return self._send(200, {'ok': True})
        if u.path == '/token':
            form = parse_qs(self._body().decode())
            ok = form.get('grant_type') == ['urn:ietf:params:oauth:grant-type:jwt-bearer'] and len(form.get('assertion', [''])[0].split('.')) == 3
            return self._send(200 if ok else 400, {'access_token': 'fake-token', 'expires_in': 3600} if ok else {'error': 'bad grant'})
        if not self._authed() or self._maybe_api_fail():
            return
        if u.path == '/drive/v3/files':
            meta = json.loads(self._body() or b'{}')
            with LOCK:
                fid = uuid.uuid4().hex[:12]
                ITEMS[fid] = {'id': fid, 'name': meta['name'], 'mimeType': meta.get('mimeType', 'application/octet-stream'),
                              'parents': meta.get('parents', [SHARED['id']]), 'data': None if meta.get('mimeType') == FOLDER else b''}
                return self._send(200, public(ITEMS[fid]))
        if u.path == '/upload/drive/v3/files' and qs.get('uploadType') == ['resumable']:
            meta = json.loads(self._body() or b'{}')
            total = int(self.headers.get('X-Upload-Content-Length') or -1)
            with LOCK:
                uid = uuid.uuid4().hex
                SESSIONS[uid] = {'meta': meta, 'total': total, 'data': bytearray(), 'done_id': None}
                STATS['uploads_started'] += 1
            host = self.headers.get('Host')
            return self._send(200, None, {'Location': f'http://{host}/upload/drive/v3/files?uploadType=resumable&upload_id={uid}'})
        self._body(); self._send(404, {'error': 'no route'})

    def do_PUT(self):
        u = urlparse(self.path); qs = parse_qs(u.query)
        if not self._authed():
            return
        uid = (qs.get('upload_id') or [''])[0]
        s = SESSIONS.get(uid)
        if not s:
            self._body(); return self._send(404, {'error': 'no such upload'})
        cr = self.headers.get('Content-Range', '')
        body = self._body()

        def finish():
            if s['done_id'] is None:
                fid = uuid.uuid4().hex[:12]
                m = s['meta']
                ITEMS[fid] = {'id': fid, 'name': m['name'], 'mimeType': m.get('mimeType', 'application/octet-stream'),
                              'parents': m.get('parents', [SHARED['id']]), 'data': bytes(s['data'])}
                s['done_id'] = fid
            return self._send(200, public(ITEMS[s['done_id']]))

        def incomplete():
            n = len(s['data'])
            return self._send(308, None, {'Range': f'bytes=0-{n - 1}'} if n else {})

        m = re.match(r'bytes \*/(\d+|\*)', cr)
        if m:  # status query
            with LOCK:
                if s['done_id'] or (m.group(1) != '*' and len(s['data']) == int(m.group(1)) == s['total']):
                    return finish()
                return incomplete()
        m = re.match(r'bytes (\d+)-(\d+)/(\d+|\*)', cr)
        if not m:
            return self._send(400, {'error': 'bad Content-Range'})
        a, b = int(m.group(1)), int(m.group(2))
        with LOCK:
            STATS['chunks'] += 1
            have = len(s['data'])
            if a > have:
                return self._send(400, {'error': f'chunk starts at {a}, have {have}'})
            r = random.random()
            if r < FAULTS.get('chunk_fail', 0):
                STATS['chunk_fail'] += 1
                return self._send(503, {'error': 'injected'})
            new = body[have - a:]
            if r < FAULTS.get('chunk_fail', 0) + FAULTS.get('chunk_partial', 0) and len(new) > 512 * 1024:
                keep = (len(new) // 2) // (256 * 1024) * (256 * 1024)
                s['data'] += new[:keep]; STATS['chunk_partial'] += 1
                return self._send(503, {'error': 'injected partial'})
            if new and random.random() < FAULTS.get('corrupt', 0):
                new = bytearray(new); new[len(new) // 2] ^= 0xFF; new = bytes(new); STATS['corrupt'] = STATS.get('corrupt', 0) + 1
            s['data'] += new
            if r < FAULTS.get('chunk_fail', 0) + FAULTS.get('chunk_partial', 0) + FAULTS.get('chunk_drop', 0):
                STATS['chunk_drop'] += 1
                if len(s['data']) == s['total']:
                    pass  # stored everything; the client must ask to learn it finished
                self.close_connection = True
                try:
                    self.connection.shutdown(2)
                except Exception:
                    pass
                return
            if len(s['data']) == s['total']:
                return finish()
            return incomplete()

    def do_PATCH(self):
        u = urlparse(self.path)
        if not self._authed() or self._maybe_api_fail():
            return
        m = re.match(r'/upload/drive/v3/files/([^/?]+)', u.path)
        body = self._body()
        with LOCK:
            if not m or m.group(1) not in ITEMS:
                return self._send(404, {'error': 'no such file'})
            ITEMS[m.group(1)]['data'] = body
            return self._send(200, {'id': m.group(1)})

    def do_DELETE(self):
        u = urlparse(self.path)
        if not self._authed():
            return
        m = re.match(r'/drive/v3/files/([^/?]+)', u.path)
        with LOCK:
            if m and m.group(1) in ITEMS:
                del ITEMS[m.group(1)]
        self._send(204)

    def do_GET(self):
        u = urlparse(self.path); qs = parse_qs(u.query)
        if u.path == '/__dump':
            with LOCK:
                return self._send(200, {'items': [{**public(i), 'path': path_of(i)} for i in ITEMS.values()], 'stats': STATS})
        if not self._authed() or self._maybe_api_fail():
            return
        if u.path == '/drive/v3/drives':
            return self._send(200, {'drives': [SHARED]})
        if u.path == '/drive/v3/files':
            q = (qs.get('q') or [''])[0]
            name = re.search(r"name = '((?:\\.|[^'\\])*)'", q)
            parent = re.search(r"'([^']+)' in parents", q)
            mime = re.search(r"mimeType = '([^']+)'", q)
            nm = re.sub(r"\\(.)", r"\1", name.group(1)) if name else None
            with LOCK:
                out = [public(i) for i in ITEMS.values()
                       if (nm is None or i['name'] == nm) and (not parent or parent.group(1) in i['parents'])
                       and (not mime or i['mimeType'] == mime.group(1))]
            return self._send(200, {'files': out})
        self._send(404, {'error': 'no route'})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
