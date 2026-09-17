from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from common.config import get_settings
from common.models import ParsedLLM
from llm.providers import LLMProvider, build_provider

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"


def _load_prompt(name: str, version: str) -> str:
    text = (PROMPTS / name).read_text(encoding="utf-8")
    return text.replace("{{PROMPT_VERSION}}", version)


def extract_json(text: str) -> dict:
    if not text:
        raise ValueError("empty LLM response")
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).rstrip("`").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in LLM response")
    return json.loads(text[start : end + 1])


class LLMParser:
    def __init__(self, provider: Optional[LLMProvider] = None, settings=None):
        self.settings = settings or get_settings()
        self.provider = provider or build_provider(self.settings)
        self.prompt_version = self.settings.prompt_version

    def _run(self, system_file: str, operation: str, raw_output: str, target: dict) -> ParsedLLM:
        if getattr(self.provider, "name", "") == "none":
            raise RuntimeError("parser skipped")
        prompt = (
            _load_prompt(system_file, self.prompt_version)
            + f"\n\noperation: {operation}\n"
            + f"target: {json.dumps(target)}\n"
            + "raw_output:\n"
            + raw_output[:24000]
        )
        last_err = None
        for attempt in range(self.settings.llm_max_retries + 1):
            try:
                content = self.provider.generate(prompt if attempt == 0 else prompt + "\nReturn valid JSON only. Previous output failed schema validation.")
                data = extract_json(content)
                parsed = ParsedLLM.model_validate(data)
                parsed.operation = operation
                return parsed
            except (json.JSONDecodeError, ValidationError, ValueError, RuntimeError) as e:
                last_err = e
        raise last_err or RuntimeError("LLM parse failed")

    def parse_network_output(self, operation: str, raw_output: str, target: Optional[dict] = None) -> ParsedLLM:
        return self._run("network_parser.txt", operation, raw_output, target or {})

    def parse_server_output(self, operation: str, raw_output: str, target: Optional[dict] = None) -> ParsedLLM:
        return self._run("server_parser.txt", operation, raw_output, target or {})

    def analyze_incident(self, facts: dict) -> dict:
        prompt = _load_prompt("incident_analysis.txt", self.prompt_version) + "\n\nFACTS:\n" + json.dumps(facts)[:24000]
        if getattr(self.provider, "name", "") == "none":
            raise RuntimeError("incident LLM skipped")
        content = self.provider.generate(prompt)
        return extract_json(content)
