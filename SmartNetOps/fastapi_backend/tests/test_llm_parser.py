import pytest

from llm.parser import extract_json, LLMParser
from llm.providers import NoneProvider
from common.models import ParsedLLM


def test_extract_json_from_fences():
    raw = '```json\n{"operation": "bgp_summary", "data": {}, "status": "success"}\n```'
    data = extract_json(raw)
    ParsedLLM.model_validate(data)


def test_extract_json_invalid():
    with pytest.raises(ValueError):
        extract_json("not json")


def test_none_provider_skips_parse():
    p = LLMParser(provider=NoneProvider())
    with pytest.raises(RuntimeError):
        p.parse_network_output("arp", "Internet 10.1.1.1")


class FakeProvider:
    name = "openai_compatible"

    def generate(self, prompt, timeout=None):
        return '{"operation":"bgp_summary","status":"success","data":{"neighbors":[{"neighbor":"10.10.10.2","state":"Active"}]},"observations":[],"anomalies":[{"category":"bgp","severity":"high","field":"10.10.10.2","observation":"BGP neighbor is not Established","evidence":"State is Active","evidence_kind":"observed"}]}'


def test_validates_llm_json():
    p = LLMParser(provider=FakeProvider())
    parsed = p.parse_network_output("bgp_summary", "Neighbor 10.10.10.2 State: Active", {"hostname": "RTR01"})
    assert parsed.data["neighbors"][0]["state"] == "Active"


class BadJson:
    name = "openai_compatible"

    def generate(self, prompt, timeout=None):
        return "sorry I cannot"


def test_invalid_llm_retries_then_fails():
    p = LLMParser(provider=BadJson())
    p.settings.llm_max_retries = 0
    with pytest.raises(ValueError):
        p.parse_network_output("arp", "x")
