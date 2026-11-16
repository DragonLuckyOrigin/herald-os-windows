"""Client for the Herald OS control socket: the agent's way to run commands in the shell's UI.

The Electron shell serves JSON-lines over a Unix socket, or a protected Windows named pipe, and
hands the backend its endpoint and a per-launch token through ``HERALD_OS_CONTROL_SOCKET`` and
``HERALD_OS_CONTROL_TOKEN``. Every request carries the token; replies are single JSON objects.
Windows verifies the native pipe identity before sending any token. Pipes and legacy TCP first
send ``{"cmd":"auth","token":...}`` and wait for ``{"ok":true}`` before the request.
Unix clients retain the original one-request/one-reply exchange.

Requests:
    {"cmd": "ui", "command": "<id>", "args": {...}, "source": "agent"}  -> CommandResult
    {"cmd": "ui-list"}                                                  -> {"ok": true, "result": [CommandSummary]}
    {"cmd": "ui-state"}                                                 -> {"ok": true, "result": {page, windows, ...}}
"""

from __future__ import annotations

import json
import os
import re
import socket
import time
from typing import Any

from .util import hermes_home, os_env
from .windows_pipe import WindowsPipe, valid_pipe_name

WINDOWS = os.name == "nt"

DEFAULT_TIMEOUT = 12.0
CANVAS_TIMEOUT = 100.0
AUTH_TIMEOUT = 5.0
MAX_AUTH_BYTES = 4096
# Provisional ceiling shared with Electron: base64 of the existing 512 MiB Canvas file-import
# limit plus 1 MiB metadata. Inline data: URLs were unbounded upstream; E2E/V8/memory qualification
# is still required. This value does not claim that the runtime can transport images this large.
MAX_REQUEST_BYTES = (512 * 1024 * 1024 * 4 + 2) // 3 + 1024 * 1024
# Export/preview return paths, not raster bytes. Qualify this provisional metadata bound as well.
MAX_REPLY_BYTES = 16 * 1024 * 1024


class ShellUnavailable(RuntimeError):
    """The shell is not running (or did not hand us a socket), so UI commands cannot run."""


def shared_endpoint() -> tuple[str, str]:
    """An attached shell publishes a private ``herald-os/control.json`` in the same Hermes home."""
    try:
        with open(hermes_home() / "herald-os" / "control.json", encoding="utf-8") as handle:
            text = handle.read(4097)
        if len(text) > 4096:
            return "", ""
        data = json.loads(text)
    except (OSError, ValueError):
        return "", ""
    if not isinstance(data, dict) or not isinstance(data.get("socket"), str) or not isinstance(data.get("token"), str):
        return "", ""
    return data["socket"], data["token"]


def _socket_address(endpoint: str) -> tuple[int, str | tuple[str, int]]:
    """Accept only the literal loopback endpoint emitted by Electron, never a remote host or URL."""
    if WINDOWS:
        raise ShellUnavailable("Windows control requires a verified local named pipe")
    if "://" in endpoint:
        match = re.fullmatch(r"tcp://127\.0\.0\.1:([1-9][0-9]{0,4})", endpoint)
        if not match or int(match[1]) > 65535:
            raise ShellUnavailable("Herald OS supplied an invalid control endpoint")
        return socket.AF_INET, ("127.0.0.1", int(match[1]))
    if not hasattr(socket, "AF_UNIX") or os.name == "nt":
        raise ShellUnavailable("Herald OS needs an authenticated loopback control endpoint on Windows")
    if not os.path.exists(endpoint):
        raise ShellUnavailable(f"The Herald OS shell is not listening ({endpoint}); is it running?")
    return socket.AF_UNIX, endpoint


def control_endpoint() -> tuple[str, str]:
    """``(endpoint, token)`` from the shell's environment, or its private shared file."""
    path = os_env("CONTROL_SOCKET").strip()
    token = os_env("CONTROL_TOKEN").strip()
    if not path and not token:
        path, token = shared_endpoint()
    if not path or not token:
        raise ShellUnavailable("Herald OS is not running this session (no control socket); UI commands need the shell.")
    if WINDOWS:
        if not valid_pipe_name(path):
            raise ShellUnavailable("Windows control requires a valid local named pipe")
    else:
        _socket_address(path)
    return path, token


def request(payload: dict[str, Any], *, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    """Send one request and return the parsed reply; raises ``ShellUnavailable`` or ``RuntimeError``."""
    path, token = control_endpoint()
    body = (json.dumps({**payload, "token": token}) + "\n").encode("utf-8")
    if len(body) > MAX_REQUEST_BYTES:
        raise RuntimeError("Herald OS control request is too large")
    family, address = (None, path) if WINDOWS else _socket_address(path)
    sock = WindowsPipe() if WINDOWS else socket.socket(family, socket.SOCK_STREAM)
    authenticate = WINDOWS or family == socket.AF_INET
    started = time.monotonic()
    deadline = started + timeout
    auth_deadline = min(deadline, started + AUTH_TIMEOUT)

    def remaining(until: float) -> float:
        value = until - time.monotonic()
        if value <= 0:
            raise TimeoutError("control reply timed out")
        return value

    def receive_reply(limit: int, until: float) -> dict[str, Any]:
        chunks = bytearray()
        while True:
            sock.settimeout(remaining(until))
            part = sock.recv(min(65536, limit + 1 - len(chunks)))
            if not part:
                break
            chunks.extend(part)
            if len(chunks) > limit:
                raise RuntimeError("Herald OS control reply is too large; the command may already have completed. Check its result before retrying.")
            if b"\n" in part:
                break
        if not chunks.strip():
            raise RuntimeError("Herald OS returned an empty reply")
        if not chunks.endswith(b"\n") or b"\n" in chunks[:-1]:
            raise RuntimeError("Herald OS returned an incomplete or multiple reply")
        try:
            reply = json.loads(chunks.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise RuntimeError(f"Herald OS returned malformed JSON: {exc}") from exc
        if not isinstance(reply, dict):
            raise RuntimeError("Herald OS returned an unexpected reply")
        return reply

    try:
        # A verified Windows pipe may be occupied by a long command. Waiting for its
        # instance consumes the caller's deadline, not the authentication budget.
        sock.settimeout(remaining(deadline if WINDOWS else auth_deadline if authenticate else deadline))
        sock.connect(address)
        if authenticate:
            if WINDOWS:
                auth_deadline = min(deadline, time.monotonic() + AUTH_TIMEOUT)
            auth = (json.dumps({"cmd": "auth", "token": token}) + "\n").encode("utf-8")
            if len(auth) > MAX_AUTH_BYTES:
                raise ShellUnavailable("Herald OS supplied an invalid control token")
            sock.settimeout(remaining(auth_deadline))
            sock.sendall(auth)
            if receive_reply(MAX_AUTH_BYTES, auth_deadline).get("ok") is not True:
                raise ShellUnavailable("Herald OS refused control authentication")
        sock.settimeout(remaining(deadline))
        sock.sendall(body)
        return receive_reply(MAX_REPLY_BYTES, deadline)
    except ConnectionRefusedError as exc:
        raise ShellUnavailable("The Herald OS control endpoint is no longer listening; restart the shell.") from exc
    except (OSError, socket.timeout) as exc:
        raise RuntimeError(f"Herald OS did not answer: {exc}") from exc
    finally:
        sock.close()


def run_command(command: str, args: dict[str, Any] | None = None, *, source: str = "agent", timeout: float | None = None) -> dict[str, Any]:
    effective_timeout = timeout if timeout is not None else CANVAS_TIMEOUT if command.startswith(("canvas.", "docs.", "sheets.", "slides.", "office.")) else DEFAULT_TIMEOUT
    return request({"cmd": "ui", "command": command, "args": args or {}, "source": source}, timeout=effective_timeout)


def list_commands() -> list[dict[str, Any]]:
    reply = request({"cmd": "ui-list"})
    if not reply.get("ok"):
        raise RuntimeError(str(reply.get("error") or "could not list commands"))
    result = reply.get("result")
    return result if isinstance(result, list) else []


def shell_state() -> dict[str, Any]:
    reply = request({"cmd": "ui-state"})
    if not reply.get("ok"):
        raise RuntimeError(str(reply.get("error") or "could not read the shell state"))
    result = reply.get("result")
    return result if isinstance(result, dict) else {}


def summarise_commands(commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trim the catalogue to what the model needs to pick and call a command."""
    out = []
    for entry in commands:
        if not isinstance(entry, dict):
            continue
        args = entry.get("args") or []
        out.append({
            "id": entry.get("id"),
            "title": entry.get("title"),
            "description": entry.get("description"),
            "tier": entry.get("tier"),
            "args": [
                {k: v for k, v in {"name": a.get("name"), "type": a.get("type"), "required": a.get("required") or False, "enum": a.get("enum"), "description": a.get("description")}.items() if v not in (None, False, [])}
                for a in args if isinstance(a, dict)
            ],
        })
    return out
