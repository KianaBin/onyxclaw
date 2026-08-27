#!/usr/bin/env python3
"""Minimal JSON-lines bridge between the Node BFF and an E2B-compatible SDK."""

import base64
import json
import os
import re
import sys
import time
from urllib.parse import urlparse


base_url = urlparse(os.environ["E2B_BASE_URL"])
if base_url.scheme not in ("http", "https") or not base_url.netloc:
    raise RuntimeError("E2B_BASE_URL must be an HTTP(S) URL")
api_url = base_url.geturl().rstrip("/")
api_domain = base_url.hostname
os.environ["E2B_API_URL"] = api_url
os.environ["E2B_DOMAIN"] = api_domain

sdk_patch = os.environ.get("E2B_SDK_PATCH", "none")
if sdk_patch == "kruise-agents-private-protocol":
    from kruise_agents.patch_e2b import patch_e2b

    patch_e2b(https=base_url.scheme == "https")
elif sdk_patch != "none":
    raise RuntimeError(f"unsupported E2B_SDK_PATCH: {sdk_patch}")
from e2b import Sandbox
from e2b.connection_config import ConnectionConfig


api_key = os.environ["E2B_API_KEY"]
sandbox_url = os.environ.get("E2B_SANDBOX_URL")
route_domain = os.environ.get("E2B_ROUTE_DOMAIN")
sessions = {}
data_session_wait_seconds = max(
    1.0, float(os.environ.get("E2B_DATA_SESSION_WAIT_SECONDS", "5"))
)


def control_api_options():
    """Authenticate control-plane calls only with the configured E2B API key."""
    return {
        "api_key": api_key,
        "api_url": api_url,
        "domain": api_domain,
    }


def safe_error(error):
    """Return useful diagnostics without exposing credentials."""
    message = str(error) or type(error).__name__
    if api_key:
        message = message.replace(api_key, "[REDACTED]")
    message = re.sub(
        r"(?i)((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)"
        r"\s*[=:]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        message,
    )[:4000]
    detail = {
        "code": "E2B_BRIDGE_OPERATION_FAILED",
        "message": message,
        "type": type(error).__name__,
    }
    for source, target in (
        ("status_code", "statusCode"),
        ("status", "statusCode"),
        ("request_id", "requestId"),
        ("requestId", "requestId"),
    ):
        value = getattr(error, source, None)
        if isinstance(value, (str, int)) and value != "":
            detail[target] = value
    return detail


def routed(session):
    traffic_token = session.traffic_access_token
    if not route_domain and not traffic_token:
        return session
    original = session.connection_config
    sandbox_headers = original.sandbox_headers
    if traffic_token:
        sandbox_headers["E2B-Traffic-Access-Token"] = traffic_token
    # A fixed Agent Gateway URL no longer carries the Sandbox identity in its
    # hostname. Forward the same routing headers used by the E2B connect API so
    # the gateway session ID remains identical to the logical Sandbox ID.
    sandbox_headers["E2b-Sandbox-Id"] = session.sandbox_id
    sandbox_headers["E2b-Sandbox-Port"] = str(original.envd_port)
    connection_config = ConnectionConfig(
        domain=original.domain,
        debug=original.debug,
        api_key=original.api_key,
        api_url=original.api_url,
        sandbox_url=sandbox_url,
        access_token=original.access_token,
        request_timeout=original.request_timeout,
        headers=original.headers.copy(),
        extra_sandbox_headers=sandbox_headers,
        proxy=original.proxy,
    )
    return Sandbox(
        sandbox_id=session.sandbox_id,
        sandbox_domain=route_domain or session.sandbox_domain,
        connection_config=connection_config,
        envd_version=session._envd_version,
        envd_access_token=session._envd_access_token,
        traffic_access_token=session.traffic_access_token,
    )


def session_for(sandbox_id):
    """Return the original session pair; reconnect only after bridge state was lost."""
    if sandbox_id not in sessions:
        claimed = Sandbox.connect(sandbox_id, **control_api_options())
        sessions[sandbox_id] = (claimed, routed(claimed))
    return sessions[sandbox_id]


def connect_session(sandbox_id):
    """Resume once and replace stale data-plane routing with connect results."""
    claimed = Sandbox.connect(sandbox_id, **control_api_options())
    sessions[sandbox_id] = (claimed, routed(claimed))
    return sessions[sandbox_id]


def run_data_operation(operation, wait_seconds=data_session_wait_seconds):
    """Wait for Agent Gateway to observe a newly connected Sandbox session."""
    deadline = time.monotonic() + wait_seconds
    delay_seconds = 1.0
    while True:
        try:
            return operation()
        except Exception as error:
            message = str(error).lower()
            transient = re.search(r"session(?: id)? not found", message) is not None
            remaining = deadline - time.monotonic()
            if not transient or remaining <= 0:
                raise
            time.sleep(min(delay_seconds, remaining))
            delay_seconds = min(delay_seconds * 2, 5.0)


def dispatch(op, params):
    if op == "create":
        claimed = Sandbox.create(
            template=params["template"],
            timeout=params.get("timeoutSeconds", 300),
            metadata=params.get("metadata"),
            envs=params.get("envs"),
            secure=params.get("secure", True),
            lifecycle={
                "on_timeout": params.get("onTimeout", "pause"),
                "auto_resume": False,
            },
            **control_api_options(),
        )
        sessions[claimed.sandbox_id] = (claimed, routed(claimed))
        return {"sandboxId": claimed.sandbox_id}

    sandbox_id = params["sandboxId"]
    if op == "pause":
        Sandbox.pause(sandbox_id, **control_api_options())
        return {"paused": True}

    if op == "connect":
        connect_session(sandbox_id)
        return {"sandboxId": sandbox_id}

    if op == "kill":
        claimed, _ = session_for(sandbox_id)
        claimed.kill()
        sessions.pop(sandbox_id, None)
        return {"killed": True}

    _, session = session_for(sandbox_id)
    if op == "command":
        result = run_data_operation(
            lambda: session.commands.run(
                params["command"],
                user=params.get("user"),
            )
        )
        return {
            "exitCode": getattr(result, "exit_code", 0),
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    if op == "writeFile":
        content = params["content"]
        if params.get("encoding") == "base64":
            content = base64.b64decode(content)
        run_data_operation(
            lambda: session.files.write(
                params["path"], content, user=params.get("user")
            )
        )
        return {"written": True}
    if op == "readFile":
        content = run_data_operation(
            lambda: session.files.read(params["path"], user=params.get("user"))
        )
        return {"content": content}
    raise ValueError("unsupported bridge operation")


for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        result = dispatch(request["op"], request.get("params", {}))
        response = {"id": request["id"], "result": result}
    except Exception as error:
        response = {
            "id": request.get("id") if isinstance(request, dict) else None,
            "error": safe_error(error),
        }
    print(json.dumps(response, separators=(",", ":")), flush=True)
