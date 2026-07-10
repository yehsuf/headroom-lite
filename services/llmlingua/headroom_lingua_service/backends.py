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
    """LLMLingua-2 backend using microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank.

    Lazy-loads on first compress() call. Thread-safe via double-checked locking.
    Requires: pip install llmlingua==0.2.2
    Optional CPU torch: pip install torch --index-url https://download.pytorch.org/whl/cpu
    """

    def __init__(self, model_name: str = 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank'):
        self._model_name = model_name
        self._compressor = None
        self._load_lock = threading.Lock()
        self._compress_lock = threading.Lock()  # serialize inference (torch not thread-safe for concurrent forward)

    def load(self) -> None:
        """Explicitly pre-warm the model. Called once at service startup if desired."""
        if self._compressor is None:
            with self._load_lock:
                if self._compressor is None:
                    try:
                        from llmlingua import PromptCompressor
                    except ImportError as e:
                        raise RuntimeError(
                            'llmlingua not installed. Run: pip install llmlingua==0.2.2'
                        ) from e
                    self._compressor = PromptCompressor(
                        model_name=self._model_name,
                        use_llmlingua2=True,
                        device_map='cpu',
                    )

    @property
    def model_loaded(self) -> bool:
        return self._compressor is not None

    def compress(self, text: str, rate: float, kind: str) -> str:
        """Compress text using LLMLingua-2. Returns compressed string."""
        self.load()  # lazy load
        with self._compress_lock:
            result = self._compressor.compress_prompt(
                text,
                rate=max(0.1, min(0.99, rate)),  # clamp: avoid 0 or 1.0 edge cases
                force_tokens=['\n', '.', ',', '!', '?'],
                drop_consecutive=True,
            )
        # compress_prompt returns a DICT — extract the compressed text
        compressed = result.get('compressed_prompt', text)
        # Safety: never return empty string
        if not compressed or not compressed.strip():
            return text
        return compressed


class SecurityLinguaBackend:
    """SecurityLingua backend for security-aware prompt compression.

    Uses SecurityLingua/securitylingua-xlm-s2s model to extract the "intention"
    from potentially adversarial prompts. Particularly effective at stripping
    jailbreak scaffolding while preserving the core request.

    Requires git install (not available in PyPI llmlingua 0.2.2):
        pip install git+https://github.com/microsoft/LLMLingua.git

    Model size: ~2.1 GiB (XLM-RoBERTa-large). Much larger than llmlingua2
    BERT-base (~677 MiB). Cold-start is significantly slower.
    """

    def __init__(self, model_name: str = 'SecurityLingua/securitylingua-xlm-s2s'):
        self._model_name = model_name
        self._compressor = None
        self._load_lock = threading.Lock()
        self._compress_lock = threading.Lock()

    def load(self) -> None:
        """Explicitly pre-warm the model. Called once at service startup if desired."""
        if self._compressor is None:
            with self._load_lock:
                if self._compressor is None:
                    try:
                        from llmlingua import PromptCompressor
                    except ImportError as e:
                        raise RuntimeError(
                            'SecurityLingua requires git install: '
                            'pip install git+https://github.com/microsoft/LLMLingua.git'
                        ) from e
                    self._compressor = PromptCompressor(
                        model_name=self._model_name,
                        use_slingua=True,
                        device_map='cpu',
                    )

    @property
    def model_loaded(self) -> bool:
        return self._compressor is not None

    def compress(self, text: str, rate: float, kind: str) -> str:
        """Compress text using SecurityLingua. Returns compressed string."""
        self.load()
        with self._compress_lock:
            result = self._compressor.compress_prompt(
                text,
                rate=max(0.1, min(0.99, rate)),
                force_tokens=['\n', '.', ',', '!', '?'],
                drop_consecutive=True,
            )
        compressed = result.get('compressed_prompt', text)
        if not compressed or not compressed.strip():
            return text
        return compressed


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
        default = 'SecurityLingua/securitylingua-xlm-s2s'
        return SecurityLinguaBackend(model_name or default)
    raise ValueError(f'Unknown backend: {name!r}. Supported: stub, llmlingua2, securitylingua')
