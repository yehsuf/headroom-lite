"""
Compression backends.

StubBackend       — deterministic, no model, always available (testing/CI).
LLMLingua2Backend — uses microsoft/llmlingua-2-* via llmlingua package (PR3).
SecurityLinguaBackend — uses SecurityLingua model (PR4).
"""
from __future__ import annotations
import threading
from typing import Protocol


class Backend(Protocol):
    def compress(self, text: str, rate: float, kind: str) -> str: ...


class StubBackend:
    """Deterministic stub — returns first `ceil(len(text) * rate)` characters.
    Predictable for tests; never loads a model.
    """
    def compress(self, text: str, rate: float, kind: str) -> str:
        import math
        keep = math.ceil(len(text) * max(0.0, min(1.0, rate)))
        return text[:keep] if keep < len(text) else text


class LLMLingua2Backend:
    """LLMLingua-2 backend. Lazy-loads model on first compress() call.
    Thread-safe load via Lock (single-process service).
    Not usable until llmlingua is installed (ImportError → RuntimeError).
    Implemented in PR3; this is a placeholder that raises NotImplementedError.
    """
    def __init__(self, model_name: str = 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank'):
        self._model_name = model_name
        self._model = None
        self._lock = threading.Lock()

    def load(self) -> None:
        raise NotImplementedError('LLMLingua2Backend.load() will be implemented in PR3')

    def compress(self, text: str, rate: float, kind: str) -> str:
        raise NotImplementedError('LLMLingua2Backend will be implemented in PR3')


class SecurityLinguaBackend:
    """SecurityLingua backend. Placeholder — implemented in PR4."""
    def __init__(self, model_name: str = 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank'):
        self._model_name = model_name
        self._model = None
        self._lock = threading.Lock()

    def compress(self, text: str, rate: float, kind: str) -> str:
        raise NotImplementedError('SecurityLinguaBackend will be implemented in PR4')


def get_backend(name: str, model_name: str | None = None) -> Backend:
    """Factory: return the right backend for `name`.
    Supported: 'stub', 'llmlingua2', 'securitylingua'.
    Unknown name → ValueError.
    """
    if name == 'stub':
        return StubBackend()
    if name == 'llmlingua2':
        default = 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank'
        return LLMLingua2Backend(model_name or default)
    if name == 'securitylingua':
        default = 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank'
        return SecurityLinguaBackend(model_name or default)
    raise ValueError(f'Unknown backend: {name!r}. Supported: stub, llmlingua2, securitylingua')
