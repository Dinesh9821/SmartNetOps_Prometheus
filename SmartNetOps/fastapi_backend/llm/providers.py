from __future__ import annotations

import json
from typing import Optional, Protocol

import httpx

from common.config import get_settings


class LLMProvider(Protocol):
    name: str

    def generate(self, prompt: str, timeout: Optional[float] = None) -> str: ...


class NoneProvider:
    name = "none"

    def generate(self, prompt: str, timeout: Optional[float] = None) -> str:
        raise RuntimeError("LLM_PROVIDER=none — parsing skipped, raw output retained")


class OpenAICompatibleProvider:
    """Works with OpenAI, Azure-compatible, vLLM, and Ollama /v1."""

    name = "openai_compatible"

    def __init__(self, base_url: str, model: str, api_key: str, timeout: float):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    def generate(self, prompt: str, timeout: Optional[float] = None) -> str:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
        }
        with httpx.Client(timeout=timeout or self.timeout) as client:
            r = client.post(f"{self.base_url}/chat/completions", headers=headers, json=body)
            r.raise_for_status()
            data = r.json()
        return data["choices"][0]["message"]["content"]


class OllamaProvider:
    name = "ollama"

    def __init__(self, base_url: str, model: str, timeout: float):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def generate(self, prompt: str, timeout: Optional[float] = None) -> str:
        url = self.base_url
        if url.endswith("/v1"):
            url = url[:-3]
        with httpx.Client(timeout=timeout or self.timeout) as client:
            r = client.post(
                f"{url}/api/generate",
                json={"model": self.model, "prompt": prompt, "stream": False, "format": "json"},
            )
            r.raise_for_status()
            return r.json().get("response", "")


class EnterpriseLLMProvider:
    """Hook for a private hosted gateway. Same OpenAI-compatible wire format."""

    name = "enterprise"

    def __init__(self, inner: OpenAICompatibleProvider):
        self.inner = inner

    def generate(self, prompt: str, timeout: Optional[float] = None) -> str:
        return self.inner.generate(prompt, timeout=timeout)


def build_provider(settings=None) -> LLMProvider:
    s = settings or get_settings()
    kind = (s.llm_provider or "none").lower()
    if kind in {"none", "off", "disabled"}:
        return NoneProvider()
    if kind == "ollama":
        return OllamaProvider(s.llm_base_url, s.llm_model, s.llm_timeout_seconds)
    compat = OpenAICompatibleProvider(s.llm_base_url, s.llm_model, s.llm_api_key, s.llm_timeout_seconds)
    if kind == "enterprise":
        return EnterpriseLLMProvider(compat)
    return compat
