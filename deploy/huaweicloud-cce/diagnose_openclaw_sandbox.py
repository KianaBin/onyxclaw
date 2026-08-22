#!/usr/bin/env python3
"""Create a short-lived AgentSphere Sandbox and verify the generated OpenClaw config."""

import argparse
import hashlib
import json
import os
import re
import time
from urllib.parse import urlparse

from e2b import Sandbox
from e2b.connection_config import ConnectionConfig


CONFIG_PATH = "/home/node/.openclaw/openclaw.json"
SOUL_PATH = "/home/node/.openclaw/workspace/SOUL.md"
MODEL_KEY_PLACEHOLDER = "__ONYXCLAW_MODEL_API_KEY__"


def required_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def replace_value(value, old, new):
    if value == old:
        return new
    if isinstance(value, list):
        return [replace_value(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: replace_value(child, old, new) for key, child in value.items()}
    return value


def build_config(base_config, model_api_key):
    config = replace_value(base_config, MODEL_KEY_PLACEHOLDER, model_api_key)
    paths = list(config.get("plugins", {}).get("load", {}).get("paths", []))
    if "/opt/onyxclaw/channel" not in paths:
        paths.append("/opt/onyxclaw/channel")
    config.setdefault("plugins", {}).setdefault("load", {})["paths"] = paths
    config["plugins"].setdefault("entries", {}).setdefault("onyxclaw", {})["enabled"] = True
    config.setdefault("channels", {})["onyxclaw"] = {
        "enabled": True,
        "platformUrl": "ws://192.168.2.13:18890/connect",
        "instanceId": "e2b-sdk-diagnostic",
        "bootstrapToken": "diagnostic-token-not-registered",
    }
    return config


def routed(session, sandbox_url):
    original = session.connection_config
    headers = original.sandbox_headers
    if session.traffic_access_token:
        headers["E2B-Traffic-Access-Token"] = session.traffic_access_token
    config = ConnectionConfig(
        domain=original.domain,
        debug=original.debug,
        api_key=original.api_key,
        api_url=original.api_url,
        sandbox_url=sandbox_url,
        access_token=original.access_token,
        request_timeout=original.request_timeout,
        headers=original.headers.copy(),
        extra_sandbox_headers=headers,
        proxy=original.proxy,
    )
    return Sandbox(
        sandbox_id=session.sandbox_id,
        sandbox_domain=session.sandbox_domain,
        connection_config=config,
        envd_version=session._envd_version,
        envd_access_token=session._envd_access_token,
        traffic_access_token=session.traffic_access_token,
    )


def sanitized(text, secrets):
    result = text
    for secret in secrets:
        if secret:
            result = result.replace(secret, "[REDACTED]")
    return re.sub(r'(?i)("?(?:api[_-]?key|token)"?\s*[:=]\s*")([^"]+)', r'\1[REDACTED]', result)


def run(session, command, secrets, timeout=120):
    try:
        result = session.commands.run(command, user="node", timeout=timeout)
    except Exception as error:
        print(json.dumps({
            "command": command,
            "error": sanitized(str(error), secrets),
        }, ensure_ascii=False))
        return None
    print(json.dumps({
        "command": command,
        "exitCode": result.exit_code,
        "stdout": sanitized(result.stdout, secrets)[-12000:],
        "stderr": sanitized(result.stderr, secrets)[-12000:],
    }, ensure_ascii=False))
    return result


def create_with_retry(create, max_attempts=6):
    for attempt in range(max_attempts):
        try:
            return create()
        except Exception as error:
            message = str(error).lower()
            transient = "sandbox.auth.0001" in message or "apikey authentication failed" in message
            if not transient or attempt + 1 >= max_attempts:
                raise
            delay = min(attempt + 1, 5)
            print(json.dumps({"stage": "create-retry", "attempt": attempt + 1, "delaySeconds": delay}))
            time.sleep(delay)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True)
    parser.add_argument("--api-url", default="https://agentsphere.cn-south-1.myhuaweicloud.com")
    parser.add_argument("--sandbox-url", required=True)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    api_key = required_env("HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY")
    model_api_key = required_env("HUAWEICLOUD_AGENTSPHERE_MODEL_API_KEY")
    base_config = json.loads(required_env("ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON"))
    config_text = json.dumps(build_config(base_config, model_api_key), separators=(",", ":"))
    metadata = {
        "agentsandbox.storage.sfs": json.dumps({
            "sfsTurboMounts": [{
                "sfsTurboId": "d38073b5-7002-4279-ab54-32faff2a0132",
                "sharePath": "/hzp/workspace",
                "readOnly": False,
                "mountDir": "/home/node/.openclaw/workspace",
            }],
        }, separators=(",", ":")),
    }
    domain = urlparse(args.api_url).hostname
    control = {"api_key": api_key, "api_url": args.api_url, "domain": domain}
    claimed = None
    try:
        claimed = create_with_retry(
            lambda: Sandbox.create(
                template=args.template,
                timeout=600,
                metadata=metadata,
                secure=True,
                lifecycle={"on_timeout": "pause"},
                **control,
            )
        )
        print(json.dumps({"sandboxId": claimed.sandbox_id, "stage": "created"}))
        session = routed(claimed, args.sandbox_url)
        session.files.write(CONFIG_PATH, config_text, user="node")
        session.files.write(SOUL_PATH, "# E2B SDK diagnostic\n", user="node")
        readback = session.files.read(CONFIG_PATH, user="node")
        print(json.dumps({
            "stage": "files",
            "path": CONFIG_PATH,
            "bytes": len(readback.encode()),
            "sha256": hashlib.sha256(readback.encode()).hexdigest(),
            "matchesGenerated": readback == config_text,
        }))

        secrets = (api_key, model_api_key)
        run(session, "node /app/openclaw.mjs config validate", secrets)
        run(session, "node /app/openclaw.mjs models status --json", secrets)
        run(
            session,
            "node /app/openclaw.mjs models status --probe --probe-provider deepseek --probe-timeout 30000 --json",
            secrets,
        )
        run(
            session,
            "id; umask; ls -ldn /home/node /home/node/.openclaw /home/node/.openclaw/workspace; "
            "find /home/node/.openclaw/workspace -maxdepth 1 -printf '%M %u:%g %m %p\\n' | sort; "
            "test -w /home/node/.openclaw/workspace && echo workspace-writable=yes || echo workspace-writable=no; "
            "test -e /home/node/.openclaw/workspace/AGENTS.md && "
            "test -w /home/node/.openclaw/workspace/AGENTS.md && echo agents-writable=yes || echo agents-writable=no",
            secrets,
        )
        for _ in range(60):
            ready = session.commands.run(
                "node -e \"fetch('http://127.0.0.1:18789/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
                user="node",
            )
            if ready.exit_code == 0:
                print(json.dumps({"stage": "gateway", "ready": True}))
                break
            time.sleep(1)
        else:
            print(json.dumps({"stage": "gateway", "ready": False}))
        run(
            session,
            "node /app/openclaw.mjs agent --local --session-id e2b-sdk-diagnostic --message 'Reply exactly: DEEPSEEK-DIAG-OK' --timeout 60 --json",
            secrets,
        )
    finally:
        if claimed and not args.keep:
            try:
                claimed.kill()
                print(json.dumps({"sandboxId": claimed.sandbox_id, "stage": "killed"}))
            except Exception as error:
                print(json.dumps({
                    "sandboxId": claimed.sandbox_id,
                    "stage": "kill-failed",
                    "error": sanitized(str(error), (api_key, model_api_key)),
                }))


if __name__ == "__main__":
    main()
