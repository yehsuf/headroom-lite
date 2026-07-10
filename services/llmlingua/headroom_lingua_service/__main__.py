"""headroom-lingua-service — LLMLingua compression microservice."""
from __future__ import annotations

import argparse
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .backends import StubBackend, get_backend

log = logging.getLogger('headroom-lingua')

_backend_name: str = 'stub'
_model_name: str = 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank'
_backend_instance: Any = None
_backend_lock = threading.Lock()
_model_loaded = False


def _get_or_init_backend() -> Any:
    """Return the initialised backend, creating it if needed.

    Also refreshes the module-level `_model_loaded` flag so `/health` and
    compress responses reflect the backend's current lazy-load state.
    """
    global _backend_instance, _model_loaded
    with _backend_lock:
        if _backend_instance is None:
            _backend_instance = get_backend(_backend_name, _model_name)
        if hasattr(_backend_instance, 'model_loaded'):
            _model_loaded = bool(_backend_instance.model_loaded)
        else:
            _model_loaded = isinstance(_backend_instance, StubBackend)
        return _backend_instance


def _compress_item(item: dict, target_rate: float) -> dict:
    backend = _get_or_init_backend()
    text = item.get('text', '')
    kind = item.get('kind', 'prose')
    original_chars = len(text)
    try:
        compressed = backend.compress(text, target_rate, kind)
        compressed_chars = len(compressed)
        did_compress = compressed_chars < original_chars
    except NotImplementedError:
        compressed = text
        compressed_chars = original_chars
        did_compress = False
    except Exception as exc:
        log.warning('compress error for item %s: %s', item.get('id'), exc)
        compressed = text
        compressed_chars = original_chars
        did_compress = False
    return {
        'id': item.get('id', ''),
        'text': compressed,
        'compressed': did_compress,
        'original_chars': original_chars,
        'compressed_chars': compressed_chars,
    }


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            _get_or_init_backend()
            self._send_json(200, {
                'status': 'ok',
                'backend': _backend_name,
                'model_name': _model_name,
                'model_loaded': _model_loaded,
            })
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/v1/compress-texts':
            self._send_json(404, {'error': 'not found'})
            return
        length = int(self.headers.get('Content-Length', 0))
        if length > 10 * 1024 * 1024:
            self._send_json(413, {'error': 'request too large'})
            return
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            self._send_json(400, {'error': f'invalid JSON: {exc}'})
            return
        if not isinstance(req, dict):
            self._send_json(400, {'error': 'request must be a JSON object'})
            return
        items = req.get('items', [])
        if not isinstance(items, list):
            self._send_json(400, {'error': 'items must be a list'})
            return
        target_rate = float(req.get('target_rate', 0.5))
        result_items = [_compress_item(item, target_rate) for item in items]
        _get_or_init_backend()  # refresh model_loaded (esp. when items is empty)
        self._send_json(200, {
            'items': result_items,
            'backend': _backend_name,
            'model_name': _model_name,
            'model_loaded': _model_loaded,
        })


def main(argv=None):
    global _backend_name, _model_name

    parser = argparse.ArgumentParser(description='headroom-lingua-service')
    parser.add_argument('--host', default=os.environ.get('HEADROOM_LINGUA_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('HEADROOM_LINGUA_PORT', '8791')))
    parser.add_argument('--backend', default=os.environ.get('HEADROOM_LITE_LOSSY_BACKEND', 'stub'))
    parser.add_argument('--model', default=os.environ.get('HEADROOM_LITE_LOSSY_MODEL',
        'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank'))
    parser.add_argument('--log-level', default='INFO')
    args = parser.parse_args(argv)

    logging.basicConfig(level=args.log_level.upper(),
                        format='%(asctime)s %(levelname)s %(name)s %(message)s')

    _backend_name = args.backend
    _model_name = args.model

    server = ThreadingHTTPServer((args.host, args.port), _Handler)
    log.info('headroom-lingua-service listening on %s:%d (backend=%s)',
             args.host, args.port, _backend_name)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
