from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = ""
    inventory_site_sql: str = ""
    inventory_device_sql: str = ""
    inventory_server_sql: str = ""

    vault_backend: str = "env"
    vault_master: str = ""

    llm_provider: str = "none"
    llm_base_url: str = "http://127.0.0.1:11434/v1"
    llm_model: str = "llama3.1"
    llm_api_key: str = ""
    llm_timeout_seconds: int = 45
    llm_max_retries: int = 2
    prompt_version: str = "1.0"

    netmiko_timeout: int = 30
    ssh_timeout: int = 25
    max_collector_concurrency: int = 8

    server_api_base_url: str = "http://127.0.0.1:8002"
    network_api_base_url: str = "http://127.0.0.1:8001"

    meraki_api_key: str = ""
    meraki_base_url: str = "https://api.meraki.com/api/v1"

    raw_capture_dir: str = "./raw_captures"


@lru_cache
def get_settings() -> Settings:
    return Settings()
