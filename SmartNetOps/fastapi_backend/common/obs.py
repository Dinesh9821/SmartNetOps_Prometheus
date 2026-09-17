from __future__ import annotations

import logging
import time
import uuid
from contextlib import contextmanager
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

log = logging.getLogger("smartnetops")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def new_request_id() -> str:
    return "REQ-" + uuid.uuid4().hex[:12].upper()


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id") or new_request_id()
        request.state.request_id = rid
        start = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        log.info(
            "http method=%s path=%s status=%s request_id=%s elapsed_ms=%.1f",
            request.method, request.url.path, response.status_code, rid,
            (time.perf_counter() - start) * 1000,
        )
        return response


@contextmanager
def timed():
    t0 = time.perf_counter()
    yield lambda: time.perf_counter() - t0
