#!/usr/bin/env python3
"""Minimal JSON-lines bridge between the Node BFF and an E2B-compatible SDK."""

import base64
import json
import os
import re
import sys
from urllib.parse import urlparse


base_url = urlparse(os.environ["E2B_BASE_URL"])
if base_url.scheme not in ("http", "https") or not base_url.netloc:
    raise RuntimeError("E2B_BASE_URL must be an HTTP(S) URL")
os.environ["E2B_DOMAIN"] = base_url.netloc

from e2b import Sandbox


api_key = os.environ["E2B_API_KEY"]
sessions = {}


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


def connect_session(sandbox_id):
    if sandbox_id not in sessions:
        claimed = Sandbox.connect(sandbox_id, api_key=api_key)
        sessions[sandbox_id] = claimed
    return sessions[sandbox_id]


def dispatch(op, params):
    if op == "create":
        claimed = Sandbox.create(
            template=params["template"],
            timeout=params.get("timeoutSeconds", 300),
            metadata=params.get("metadata"),
            envs=params.get("envs"),
            secure=params.get("secure", True),
            api_key=api_key,
        )
        sessions[claimed.sandbox_id] = claimed
        return {"sandboxId": claimed.sandbox_id}

    sandbox_id = params["sandboxId"]
    session = connect_session(sandbox_id)
    if op == "connect":
        return {"sandboxId": sandbox_id}
    if op == "command":
        result = session.commands.run(
            params["command"],
            user=params.get("user"),
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
        session.files.write(params["path"], content, user=params.get("user"))
        return {"written": True}
    if op == "readFile":
        content = session.files.read(params["path"], user=params.get("user"))
        return {"content": content}
    if op == "kill":
        session.kill()
        sessions.pop(sandbox_id, None)
        return {"killed": True}
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
