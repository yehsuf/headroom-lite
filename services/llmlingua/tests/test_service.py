"""Tests for headroom-lingua-service."""
from __future__ import annotations

import contextlib
import http.client
import json
import socket
import threading
from http.server import HTTPServer

import pytest

import headroom_lingua_service.__main__ as svc
from headroom_lingua_service.backends import (
    LLMLingua2Backend,
    SecurityLinguaBackend,
    StubBackend,
    get_backend,
)


# ---------- StubBackend ---------------------------------------------------

def test_stub_compress_returns_shorter_text():
    text = 'The quick brown fox jumps over the lazy dog. ' * 20
    result = StubBackend().compress(text, 0.5, 'prose')
    assert len(result) < len(text)


def test_stub_compress_rate_1_returns_original():
    text = 'hello world'
    assert StubBackend().compress(text, 1.0, 'prose') == text


def test_stub_compress_rate_0_returns_empty_or_minimal():
    text = 'hello world'
    result = StubBackend().compress(text, 0.0, 'prose')
    assert len(result) <= 1


def test_stub_compress_deterministic():
    b = StubBackend()
    text = 'The quick brown fox jumps over the lazy dog.' * 3
    a = b.compress(text, 0.5, 'prose')
    c = b.compress(text, 0.5, 'prose')
    assert a == c


@pytest.mark.parametrize('kind', ['prose', 'log', 'stack_trace', 'code'])
def test_stub_compress_all_kinds(kind):
    text = 'abcdefghij' * 5
    result = StubBackend().compress(text, 0.5, kind)
    assert isinstance(result, str)
    assert len(result) < len(text)


# ---------- get_backend factory ------------------------------------------

def test_get_backend_stub():
    assert isinstance(get_backend('stub'), StubBackend)


def test_get_backend_llmlingua2():
    assert isinstance(get_backend('llmlingua2'), LLMLingua2Backend)


def test_get_backend_securitylingua():
    assert isinstance(get_backend('securitylingua'), SecurityLinguaBackend)


def test_get_backend_unknown_raises():
    with pytest.raises(ValueError):
        get_backend('nope')


def test_get_backend_llmlingua2_notimplemented():
    b = get_backend('llmlingua2')
    with pytest.raises(NotImplementedError):
        b.compress('x', 0.5, 'prose')


def test_get_backend_securitylingua_notimplemented():
    b = get_backend('securitylingua')
    with pytest.raises(NotImplementedError):
        b.compress('x', 0.5, 'prose')


# ---------- _compress_item -----------------------------------------------

@contextlib.contextmanager
def _reset_svc_state(backend='stub', model_name=None):
    orig_backend, orig_model = svc._backend_name, svc._model_name
    orig_instance, orig_loaded = svc._backend_instance, svc._model_loaded
    svc._backend_name = backend
    svc._model_name = model_name or svc._model_name
    svc._backend_instance = None
    svc._model_loaded = False
    try:
        yield
    finally:
        svc._backend_name = orig_backend
        svc._model_name = orig_model
        svc._backend_instance = orig_instance
        svc._model_loaded = orig_loaded


def test_compress_item_stub_success():
    with _reset_svc_state('stub'):
        item = {'id': 'm0:text', 'text': 'The quick brown fox.' * 10, 'kind': 'prose'}
        result = svc._compress_item(item, 0.5)
    assert result['id'] == 'm0:text'
    assert result['compressed'] is True
    assert result['original_chars'] == len(item['text'])
    assert result['compressed_chars'] < result['original_chars']


def test_compress_item_handles_notimplemented():
    with _reset_svc_state('llmlingua2'):
        item = {'id': 'x', 'text': 'hello world', 'kind': 'prose'}
        result = svc._compress_item(item, 0.5)
    assert result['compressed'] is False
    assert result['text'] == 'hello world'
    assert result['original_chars'] == result['compressed_chars']


def test_compress_item_handles_exception(monkeypatch):
    class BoomBackend:
        def compress(self, text, rate, kind):
            raise RuntimeError('boom')
    with _reset_svc_state('stub'):
        svc._backend_instance = BoomBackend()
        svc._model_loaded = True
        item = {'id': 'x', 'text': 'hello world', 'kind': 'prose'}
        result = svc._compress_item(item, 0.5)
    assert result['compressed'] is False
    assert result['text'] == 'hello world'


def test_compress_item_empty_text():
    with _reset_svc_state('stub'):
        item = {'id': 'e', 'text': '', 'kind': 'prose'}
        result = svc._compress_item(item, 0.5)
    assert result['compressed'] is False
    assert result['original_chars'] == 0
    assert result['compressed_chars'] == 0


# ---------- HTTP test server helper --------------------------------------

@contextlib.contextmanager
def _test_server(backend='stub', model_name=None):
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]

    orig_backend, orig_model = svc._backend_name, svc._model_name
    orig_instance, orig_loaded = svc._backend_instance, svc._model_loaded
    svc._backend_name = backend
    svc._model_name = model_name or svc._model_name
    svc._backend_instance = None
    svc._model_loaded = False

    server = HTTPServer(('127.0.0.1', port), svc._Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield f'127.0.0.1:{port}'
    finally:
        server.shutdown()
        server.server_close()
        svc._backend_name = orig_backend
        svc._model_name = orig_model
        svc._backend_instance = orig_instance
        svc._model_loaded = orig_loaded


def _http_request(host_port, method, path, body=None, headers=None, raw_body=None):
    conn = http.client.HTTPConnection(host_port, timeout=5)
    hdr = {'Content-Type': 'application/json'}
    if headers:
        hdr.update(headers)
    if raw_body is not None:
        conn.request(method, path, body=raw_body, headers=hdr)
    elif body is not None:
        conn.request(method, path, body=json.dumps(body), headers=hdr)
    else:
        conn.request(method, path, headers=hdr)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


# ---------- HTTP server — /health ---------------------------------------

def test_health_returns_200():
    with _test_server('stub') as hp:
        status, _ = _http_request(hp, 'GET', '/health')
    assert status == 200


def test_health_json_has_required_fields():
    with _test_server('stub') as hp:
        _, data = _http_request(hp, 'GET', '/health')
    obj = json.loads(data)
    assert obj['status'] == 'ok'
    assert 'backend' in obj
    assert 'model_name' in obj
    assert 'model_loaded' in obj


def test_health_does_not_load_model():
    with _test_server('llmlingua2') as hp:
        _, data = _http_request(hp, 'GET', '/health')
    obj = json.loads(data)
    assert obj['backend'] == 'llmlingua2'
    assert obj['model_loaded'] is False


# ---------- HTTP server — /v1/compress-texts ----------------------------

def test_compress_texts_empty_items():
    with _test_server('stub') as hp:
        status, data = _http_request(hp, 'POST', '/v1/compress-texts',
                                     body={'items': [], 'target_rate': 0.5})
    assert status == 200
    obj = json.loads(data)
    assert obj['items'] == []


def test_compress_texts_single_item_stub():
    with _test_server('stub') as hp:
        item = {'id': 'm0:text', 'text': 'hello world hello world hello world', 'kind': 'prose'}
        status, data = _http_request(hp, 'POST', '/v1/compress-texts',
                                     body={'items': [item], 'target_rate': 0.5})
    assert status == 200
    obj = json.loads(data)
    assert len(obj['items']) == 1
    r = obj['items'][0]
    assert r['id'] == 'm0:text'
    assert r['compressed'] is True
    assert r['compressed_chars'] < r['original_chars']


def test_compress_texts_multiple_items():
    with _test_server('stub') as hp:
        items = [
            {'id': 'm0:text', 'text': 'aaa' * 20, 'kind': 'prose'},
            {'id': 'm1:text', 'text': 'bbb' * 20, 'kind': 'log'},
            {'id': 'm2:text', 'text': 'ccc' * 20, 'kind': 'code'},
        ]
        status, data = _http_request(hp, 'POST', '/v1/compress-texts',
                                     body={'items': items, 'target_rate': 0.5})
    assert status == 200
    obj = json.loads(data)
    assert len(obj['items']) == 3
    assert [r['id'] for r in obj['items']] == ['m0:text', 'm1:text', 'm2:text']


def test_compress_texts_invalid_json():
    with _test_server('stub') as hp:
        status, _ = _http_request(hp, 'POST', '/v1/compress-texts',
                                  raw_body=b'{not json')
    assert status == 400


def test_compress_texts_missing_items():
    with _test_server('stub') as hp:
        status, data = _http_request(hp, 'POST', '/v1/compress-texts',
                                     body={'target_rate': 0.5})
    assert status == 200
    obj = json.loads(data)
    assert obj['items'] == []


def test_compress_texts_non_list_items():
    with _test_server('stub') as hp:
        status, _ = _http_request(hp, 'POST', '/v1/compress-texts',
                                  body={'items': 42})
    assert status == 400


def test_compress_texts_large_request_rejected():
    with _test_server('stub') as hp:
        conn = http.client.HTTPConnection(hp, timeout=5)
        # Send a Content-Length header claiming >10MB without sending the body.
        conn.putrequest('POST', '/v1/compress-texts')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(10 * 1024 * 1024 + 1))
        conn.endheaders()
        resp = conn.getresponse()
        status = resp.status
        resp.read()
        conn.close()
    assert status == 413


def test_compress_texts_result_has_required_fields():
    with _test_server('stub') as hp:
        item = {'id': 'x', 'text': 'The quick brown fox.' * 5, 'kind': 'prose'}
        _, data = _http_request(hp, 'POST', '/v1/compress-texts',
                                body={'items': [item], 'target_rate': 0.5})
    r = json.loads(data)['items'][0]
    for k in ('id', 'text', 'compressed', 'original_chars', 'compressed_chars'):
        assert k in r


# ---------- HTTP routing -------------------------------------------------

def test_unknown_get_path():
    with _test_server('stub') as hp:
        status, _ = _http_request(hp, 'GET', '/does/not/exist')
    assert status == 404


def test_unknown_post_path():
    with _test_server('stub') as hp:
        status, _ = _http_request(hp, 'POST', '/some/other', body={})
    assert status == 404


def test_post_to_health_is_404():
    with _test_server('stub') as hp:
        status, _ = _http_request(hp, 'POST', '/health', body={})
    assert status == 404
