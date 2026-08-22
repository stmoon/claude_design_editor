#!/usr/bin/env python3
"""Claude Design Editor - a local slide editor for static HTML decks.

    python3 editor.py <deck-dir-or-html> [--port 8770] [--no-open]

Serves the editor UI and the target deck directory over loopback, and writes
edits straight back to the file on disk. Every write is confined to the target
directory; nothing outside it is reachable.
"""

import argparse
import json
import mimetypes
import posixpath
import re
import socketserver
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler
from pathlib import Path

APP = Path(__file__).resolve().parent / 'app'

# Overridable per deck via cde.config.json in the target directory.
DEFAULT_CONFIG = {
    'slide': 'section.slide',           # what counts as one slide
    'body': '.body',                    # the region layouts rearrange
    'title': '.title, h1, h2',          # used for the slide list labels
    'media': 'figure, table, .tbl, .fig-stack, img, svg, pre',
    'editable': ('.title, .kicker, .course, .display, .presenter, .lead, '
                 '.foot-sec, .ul li, .tbl th, .tbl td, .card, p'),
    'imageDir': 'imgs',
    'autosave': True,
}

WRITABLE_SUFFIXES = {'.html', '.htm', '.css', '.js', '.svg', '.md', '.json'}
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif'}

TARGET = Path('.')
DECK_FILE = None


def confined(root, url_path):
    """Map a URL path to a file under root, or None if it points outside."""
    # Unquote first: normalizing before decoding would let %2e%2e survive as '..'.
    rel = posixpath.normpath(urllib.parse.unquote(url_path)).lstrip('/')
    target = (root / rel).resolve()
    root = root.resolve()
    return target if target == root or root in target.parents else None


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    path = TARGET / 'cde.config.json'
    if path.is_file():
        try:
            cfg.update(json.loads(path.read_text(encoding='utf-8')))
        except (ValueError, OSError) as err:
            print(f'cde.config.json 무시: {err}')
    cfg['deck'] = DECK_FILE.name if DECK_FILE else ''
    return cfg


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'ClaudeDesignEditor'

    # --- plumbing -------------------------------------------------------
    def _send(self, code, body=b'', ctype='text/plain; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD' and body:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'),
                   'application/json; charset=utf-8')

    def _file(self, path):
        if path is None or not path.is_file():
            return self._send(404, b'not found')
        ctype = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'image/svg+xml'):
            ctype += '; charset=utf-8'
        self._send(200, path.read_bytes(), ctype)

    def _body(self, limit=64 * 1024 * 1024):
        n = int(self.headers.get('Content-Length', 0))
        return self.rfile.read(n) if 0 < n <= limit else None

    def log_message(self, fmt, *args):
        pass

    # --- routes ---------------------------------------------------------
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path, query = url.path, urllib.parse.parse_qs(url.query)

        if path == '/':
            return self._file(APP / 'editor.html')
        if path.startswith('/_app/'):
            return self._file(confined(APP, path[len('/_app'):]))
        if path == '/_config':
            return self._json(load_config())
        if path == '/_files':
            return self._json({'files': sorted(p.name for p in TARGET.glob('*.html'))})
        if path == '/_stat':
            target = confined(TARGET, '/' + query.get('path', [''])[0])
            if target is None or not target.is_file():
                return self._json({'mtime': 0})
            return self._json({'mtime': target.stat().st_mtime})
        if path.startswith('/deck/'):
            return self._file(confined(TARGET, path[len('/deck'):]))
        self._send(404, b'not found')

    do_HEAD = do_GET

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith('/deck/'):
            return self._send(404, b'not found')
        target = confined(TARGET, path[len('/deck'):])
        if target is None or target.suffix.lower() not in WRITABLE_SUFFIXES:
            return self._send(403, b'write not allowed')
        data = self._body()
        if data is None:
            return self._send(400, b'empty body')
        target.write_bytes(data)
        print(f'saved {target.name} ({len(data)} bytes)', flush=True)
        self._json({'ok': True, 'name': target.name,
                    'mtime': target.stat().st_mtime})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        raw = query.get('name', [''])[0]
        name = re.sub(r'[^A-Za-z0-9._-]', '_', Path(raw).name)

        if url.path == '/_upload':
            if not name or Path(name).suffix.lower() not in IMAGE_SUFFIXES:
                return self._send(400, b'bad image name')
            data = self._body()
            if data is None:
                return self._send(400, b'empty body')
            folder = TARGET / load_config()['imageDir']
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / name
            # Never clobber an existing figure - park the new file beside it.
            stem, suffix, i = target.stem, target.suffix, 2
            while target.exists():
                target = folder / f'{stem}-{i}{suffix}'
                i += 1
            target.write_bytes(data)
            print(f'uploaded {folder.name}/{target.name} ({len(data)} bytes)', flush=True)
            return self._json({'src': f'{folder.name}/{target.name}'})

        if url.path == '/_saveas':
            if not name or Path(name).suffix.lower() not in ('.html', '.htm'):
                return self._send(400, b'bad file name')
            data = self._body()
            if data is None:
                return self._send(400, b'empty body')
            target = TARGET / name
            if target.exists() and query.get('overwrite', ['0'])[0] != '1':
                return self._json({'exists': True, 'name': name}, 409)
            target.write_bytes(data)
            print(f'saved as {name} ({len(data)} bytes)', flush=True)
            return self._json({'ok': True, 'name': name,
                               'mtime': target.stat().st_mtime})

        self._send(404, b'not found')


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    global TARGET, DECK_FILE
    ap = argparse.ArgumentParser(description='Claude Design Editor')
    ap.add_argument('target', nargs='?', default='.',
                    help='deck directory, or a single .html file')
    ap.add_argument('--port', type=int, default=8770)
    ap.add_argument('--no-open', action='store_true')
    args = ap.parse_args()

    target = Path(args.target).resolve()
    if target.is_file():
        TARGET, DECK_FILE = target.parent, target
    elif target.is_dir():
        TARGET = target
        html = sorted(TARGET.glob('*.html'))
        DECK_FILE = html[0] if html else None
    else:
        sys.exit(f'대상이 없다: {target}')
    if DECK_FILE is None:
        sys.exit(f'HTML 파일이 없다: {TARGET}')

    # Ship the persistent layout stylesheet next to the deck so saved files
    # keep their layout without the editor running.
    layout = APP / 'cde-layout.css'
    if layout.is_file():
        (TARGET / 'cde-layout.css').write_bytes(layout.read_bytes())

    url = f'http://127.0.0.1:{args.port}/'
    with Server(('127.0.0.1', args.port), Handler) as srv:
        print(f'Claude Design Editor  {url}')
        print(f'  대상 : {TARGET}')
        print(f'  덱   : {DECK_FILE.name}')
        print('  Ctrl+C 로 종료')
        if not args.no_open:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print('\n종료')


if __name__ == '__main__':
    main()
