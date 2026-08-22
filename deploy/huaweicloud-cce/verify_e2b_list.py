#!/usr/bin/env python3
"""Verify an E2B-compatible endpoint and API key with Sandbox.list()."""

import argparse
from getpass import getpass
import importlib.metadata
import json
import os
import re
import sys
from urllib.parse import urlparse


def parse_args():
    parser = argparse.ArgumentParser(
        description="Call the E2B Sandbox.list API without creating resources."
    )
    parser.add_argument(
        "--api-url",
        default=os.environ.get("E2B_API_URL"),
        help="E2B API URL or hostname; defaults to E2B_API_URL.",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("E2B_API_KEY"),
        help="E2B API key; defaults to E2B_API_KEY. Prefer --prompt-api-key.",
    )
    parser.add_argument(
        "--prompt-api-key",
        action="store_true",
        help="Read the API key from a hidden terminal prompt.",
    )
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def normalize_api_url(value):
    if not value:
        raise ValueError("E2B API URL is required")
    candidate = value.strip()
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("E2B API URL must be an HTTP(S) URL or hostname")
    return candidate.rstrip("/"), parsed.hostname


def safe_error(error, api_key):
    message = str(error) or type(error).__name__
    if api_key:
        message = message.replace(api_key, "[REDACTED]")
    message = re.sub(
        r"(?i)((?:api[_-]?key|authorization|token|secret)\s*[=:]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        message,
    )[:2000]
    detail = {
        "ok": False,
        "errorType": type(error).__name__,
        "message": message,
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


def main():
    args = parse_args()
    api_url, domain = normalize_api_url(args.api_url)
    api_key = getpass("E2B API key: ") if args.prompt_api_key else args.api_key
    if not api_key:
        raise ValueError("E2B API key is required")
    if args.limit <= 0:
        raise ValueError("limit must be positive")

    try:
        from e2b import Sandbox

        paginator = Sandbox.list(
            limit=args.limit,
            api_key=api_key,
            api_url=api_url,
            domain=domain,
            request_timeout=args.timeout,
        )
        items = paginator.next_items()
        print(
            json.dumps(
                {
                    "ok": True,
                    "sdk": "e2b",
                    "sdkVersion": importlib.metadata.version("e2b"),
                    "apiUrl": api_url,
                    "operation": "Sandbox.list",
                    "network": "reachable",
                    "authentication": "accepted",
                    "firstPageCount": len(items),
                    "hasNextPage": paginator.has_next,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as error:
        detail = safe_error(error, api_key)
        detail.update(
            {
                "sdk": "e2b",
                "apiUrl": api_url,
                "operation": "Sandbox.list",
            }
        )
        print(json.dumps(detail, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "errorType": type(error).__name__,
                    "message": str(error),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        raise SystemExit(2)
