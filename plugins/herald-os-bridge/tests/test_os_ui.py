"""The ``os_ui`` tool: socket client, tier mapping from the shell's catalogue, approval and audit.

A fake control server stands in for the Electron shell; ``authorize`` is captured."""

from __future__ import annotations

import importlib
import base64
import json
import os
import shutil
import socket
import tempfile
import threading
from types import SimpleNamespace

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


CATALOGUE = [
    {"id": "page.open", "title": "Open a page or app", "description": "", "tier": "read", "args": [{"name": "name", "type": "string", "required": True, "description": "Page"}], "phrases": [], "hidden": False},
    {"id": "memory.add", "title": "Remember something", "description": "", "tier": "mutate", "args": [{"name": "text", "type": "string", "required": True, "description": "Text"}], "phrases": [], "hidden": False},
    {"id": "memory.forget", "title": "Forget a memory", "description": "", "tier": "destructive", "args": [{"name": "match", "type": "string", "required": True, "description": "Match"}], "phrases": [], "hidden": False},
]


class FakeShell:
    """A real local JSON-lines transport answering like the Electron control server."""

    def __init__(self, path: str, token: str, transport: str):
        self.path, self.token = path, token
        self.transport = transport
        self.requests: list[dict] = []
        self.stopped = threading.Event()
        self.server = socket.socket(socket.AF_INET if transport == "tcp" else socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0) if transport == "tcp" else path)
        self.endpoint = f"tcp://127.0.0.1:{self.server.getsockname()[1]}" if transport == "tcp" else path
        self.server.listen(4)
        self.server.settimeout(0.1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while not self.stopped.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                conn.settimeout(1.0)
                for stage in range(2 if self.transport == "tcp" else 1):
                    data = bytearray()
                    while not data.endswith(b"\n"):
                        part = conn.recv(65536)
                        if not part:
                            break
                        data.extend(part)
                    if not data:
                        break
                    request = json.loads(data.decode())
                    if self.transport == "tcp" and stage == 0:
                        reply = {"ok": request.get("cmd") == "auth" and request.get("token") == self.token}
                        conn.sendall((json.dumps(reply) + "\n").encode())
                        if not reply["ok"]:
                            break
                    else:
                        self.requests.append(request)
                        conn.sendall((json.dumps(self._reply(request)) + "\n").encode())

    def _reply(self, request: dict) -> dict:
        if request.get("token") != self.token:
            return {"ok": False, "error": "invalid control token"}
        cmd = request.get("cmd")
        if cmd == "ui-list":
            return {"ok": True, "result": CATALOGUE}
        if cmd == "ui-state":
            return {"ok": True, "result": {"page": "overview", "windows": []}}
        if cmd == "ui":
            if request.get("command") == "page.open":
                return {"ok": True, "summary": f"Opened {request['args'].get('name')}", "page": request["args"].get("name")}
            if request.get("command") == "memory.add":
                return {"ok": True, "summary": "Remembered", "highlight": {"kind": "memory", "id": "MEMORY.md:3"}}
            return {"ok": False, "error": "nope"}
        return {"ok": False, "error": "unknown"}

    def close(self):
        self.stopped.set()
        self.server.close()
        self.thread.join(timeout=2.0)
        assert not self.thread.is_alive()
        if self.transport == "tcp":
            return
        try:
            os.unlink(self.path)
        except OSError:
            pass


@pytest.fixture
def legacy_socket_transport(plugin, monkeypatch):
    """Exercise the Unix/legacy protocol, not native Windows pipe security."""
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "WINDOWS", False)
    return ui


@pytest.fixture(params=["tcp"] + (["unix"] if os.name != "nt" and hasattr(socket, "AF_UNIX") else []), ids=lambda value: "legacy-tcp" if value == "tcp" else "native-unix")
def shell(monkeypatch, plugin, request, legacy_socket_transport):
    # AF_UNIX paths are capped at ~104 bytes on macOS; pytest's tmp_path is far longer.
    short_dir = tempfile.mkdtemp(prefix="hos-", dir="/tmp" if request.param == "unix" else None)
    path = os.path.join(short_dir, "c.sock")
    fake = FakeShell(path, "secret-token", request.param)
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", fake.endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.clear()
    yield fake
    fake.close()
    tools._UI_CATALOGUE.clear()
    shutil.rmtree(short_dir, ignore_errors=True)


@pytest.fixture
def decisions(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    seen = []

    def authorize(tool, tier, action, summary, *, paths=()):
        seen.append((tool, tier, action, summary))
        return perm.Decision(True, "allowed")

    monkeypatch.setattr(tools, "authorize", authorize)
    return seen


def test_run_read_command_through_socket(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "page.open", "args": {"name": "memory"}}))
    assert reply["success"] is True
    assert reply["page"] == "memory"
    assert decisions[-1][0] == "os_ui" and decisions[-1][1].value == "read" and decisions[-1][2] == "page.open"
    assert shell.requests[-1]["token"] == "secret-token" and shell.requests[-1]["source"] == "agent"


def test_tier_comes_from_the_catalogue(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    json.loads(tools.handle_os_ui({"action": "run", "command": "memory.add", "args": {"text": "likes tea"}}))
    assert decisions[-1][1].value == "mutate"
    assert "likes tea" in decisions[-1][3]
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    assert tools.ui_tier_for("memory.forget", catalogue).value == "destructive"
    assert tools.ui_tier_for("mystery.command", catalogue).value == "mutate"


@pytest.mark.parametrize("declared", ["read", "act", "mutate", "destructive", None])
def test_windows_external_open_has_a_destructive_floor(plugin, monkeypatch, declared):
    tools = _mod(plugin, "tools")
    monkeypatch.setattr(tools, "os", SimpleNamespace(name="nt"))
    catalogue = {"file.openExternal": {"tier": declared}}
    assert tools.ui_tier_for("file.openExternal", catalogue).value == "destructive"
    assert tools.ui_tier_for("file.openExternal", {}).value == "destructive"


@pytest.mark.parametrize("command_args", [{"path": r"C:\private\run.exe"}, {"path": r"C:\private\notes.txt"}, {}])
def test_windows_external_open_denial_precedes_dispatch(plugin, monkeypatch, command_args):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    monkeypatch.setattr(tools, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(tools, "_ui_catalogue", lambda: {"file.openExternal": {"tier": "act"}})
    confirmations, dispatched, audit = [], [], []

    def deny(tool, summary, rule_key):
        confirmations.append((tool, summary, rule_key))
        return perm.Decision(False, "denied", "declined for test")

    monkeypatch.setattr(perm, "_confirm", deny)
    monkeypatch.setattr(tools.ui, "run_command", lambda *args, **kwargs: dispatched.append(args) or {"ok": True})
    monkeypatch.setattr(tools.audit, "record", lambda **entry: audit.append(entry))
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "file.openExternal", "args": command_args}))
    assert reply["success"] is False and reply["decision"] == "denied"
    assert len(confirmations) == 1 and confirmations[0][0] == "os_ui"
    assert not dispatched
    assert audit[-1]["tier"] == "destructive" and audit[-1]["decision"] == "denied"


@pytest.mark.parametrize("declared", ["read", "act", "mutate", "destructive"])
def test_posix_external_open_preserves_the_catalogue_tier(plugin, monkeypatch, declared):
    tools = _mod(plugin, "tools")
    monkeypatch.setattr(tools, "os", SimpleNamespace(name="posix"))
    assert tools.ui_tier_for("file.openExternal", {"file.openExternal": {"tier": declared}}).value == declared


def test_unknown_command_is_rejected_before_authorizing(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "nope.x"}))
    assert reply["success"] is False and "unknown command" in reply["error"]
    assert not decisions


def test_list_and_state(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    listed = json.loads(tools.handle_os_ui({"action": "list"}))
    assert [c["id"] for c in listed["commands"]] == ["page.open", "memory.add", "memory.forget"]
    assert listed["commands"][0]["args"][0]["required"] is True
    state = json.loads(tools.handle_os_ui({"action": "state"}))
    assert state["page"] == "overview"


def test_shell_refusal_becomes_a_tool_error(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.update({"memory.forget": CATALOGUE[2]})
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "memory.forget", "args": {"match": "x"}}))
    assert reply["success"] is False and reply["error"] == "nope"


def test_string_args_are_parsed(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "page.open", "args": '{"name": "memory"}'}))
    assert reply["success"] is True and reply["page"] == "memory"


def test_system_open_stays_inside_the_os(plugin, shell, decisions, tmp_path):
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.update({
        "web.open": {"id": "web.open", "title": "Open a web page", "tier": "act"},
        "file.open": {"id": "file.open", "title": "Open a file", "tier": "act"},
        "files.show": {"id": "files.show", "title": "Show in Files", "tier": "read"},
    })
    doc = tmp_path / "hello.pdf"
    doc.write_bytes(b"%PDF-1.4")
    json.loads(tools.handle_system_open({"target": "url", "url": "https://example.com"}))
    assert shell.requests[-1]["command"] == "web.open" and shell.requests[-1]["args"] == {"url": "https://example.com"}
    json.loads(tools.handle_system_open({"target": "path", "path": str(doc)}))
    assert shell.requests[-1]["command"] == "file.open" and shell.requests[-1]["args"] == {"name": str(doc)}
    json.loads(tools.handle_system_open({"target": "reveal", "path": str(doc)}))
    assert shell.requests[-1]["command"] == "files.show"
    json.loads(tools.handle_system_open({"target": "path", "path": str(tmp_path)}))
    assert shell.requests[-1]["command"] == "files.show"


def test_system_open_with_a_named_app_uses_the_host(plugin, shell, decisions, monkeypatch, tmp_path):
    tools = _mod(plugin, "tools")
    opened = []
    fake_host = type("H", (), {"open_path": lambda self, path, app: opened.append((str(path), app)), "platform": "darwin"})()
    monkeypatch.setattr(tools, "host", lambda: fake_host)
    doc = tmp_path / "hello.pdf"
    doc.write_bytes(b"%PDF-1.4")
    before = len(shell.requests)
    reply = json.loads(tools.handle_system_open({"target": "path", "path": str(doc), "app": "Preview"}))
    assert reply["success"] is True and opened == [(str(doc), "Preview")]
    assert len(shell.requests) == before


def test_system_open_editor_uses_the_first_installed_editor(plugin, shell, decisions, monkeypatch, tmp_path):
    tools = _mod(plugin, "tools")
    opened, installed = [], {"Cursor", "Zed"}
    fake_host = type("H", (), {
        "open_path": lambda self, path, app: opened.append((str(path), app)),
        "resolve_app": lambda self, name: name if name in installed else None,
        "platform": "darwin",
    })()
    monkeypatch.setattr(tools, "host", lambda: fake_host)
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path)}))
    assert reply["success"] is True and opened == [(str(tmp_path), "Cursor")]
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path), "editor": "zed"}))
    assert reply["success"] is True and opened[-1] == (str(tmp_path), "Zed")
    installed.clear()
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path)}))
    assert reply["success"] is False and "Visual Studio Code, Cursor, Zed" in reply["error"]


def test_without_shell_the_tool_explains(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    monkeypatch.delenv("HERALD_OS_CONTROL_SOCKET", raising=False)
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    reply = json.loads(tools.handle_os_ui({"action": "state"}))
    assert reply["success"] is False and "control socket" in reply["error"]


def test_wrong_token_is_refused(plugin, shell, monkeypatch):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "incorrect")
    if shell.transport == "tcp":
        with pytest.raises(ui.ShellUnavailable, match="refused control authentication"):
            ui.request({"cmd": "ui-state"})
        assert not shell.requests
    else:
        assert ui.request({"cmd": "ui-state"}) == {"ok": False, "error": "invalid control token"}


@pytest.mark.parametrize("endpoint", [
    "tcp://localhost:1234", "tcp://0.0.0.0:1234", "tcp://192.168.1.2:1234",
    "tcp://[::1]:1234", "tcp://127.0.0.1:0", "tcp://127.0.0.1:65536",
    "tcp://127.0.0.1:01234", "tcp://user@127.0.0.1:1234", "tcp://127.0.0.1:1234/path",
    "tcp://127.0.0.1:1234?token=x", "http://127.0.0.1:1234", "tcp://127.0.0.1:1234#x",
])
def test_nonliteral_or_malformed_tcp_endpoint_is_rejected(plugin, monkeypatch, endpoint, legacy_socket_transport):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret")
    with pytest.raises(ui.ShellUnavailable, match="invalid control endpoint"):
        ui.control_endpoint()


def test_shared_endpoint_uses_the_runtime_hermes_home(plugin, shell, monkeypatch, tmp_path):
    ui = _mod(plugin, "ui")
    home = tmp_path / "native-home"
    directory = home / "herald-os"
    directory.mkdir(parents=True)
    (directory / "control.json").write_text(json.dumps({"socket": shell.endpoint, "token": shell.token}), encoding="utf-8")
    monkeypatch.setattr(ui, "hermes_home", lambda: home)
    monkeypatch.delenv("HERALD_OS_CONTROL_SOCKET", raising=False)
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    assert ui.shell_state()["page"] == "overview"


def test_unset_hermes_home_uses_the_official_runtime_default(plugin, monkeypatch, tmp_path):
    import sys
    ui = _mod(plugin, "ui")
    runtime_home = tmp_path / "LocalAppData" / "hermes"
    directory = runtime_home / "herald-os"
    directory.mkdir(parents=True)
    expected = ("tcp://127.0.0.1:1234", "test-token")
    (directory / "control.json").write_text(json.dumps({"socket": expected[0], "token": expected[1]}), encoding="utf-8")
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setitem(sys.modules, "hermes_constants", SimpleNamespace(get_hermes_home=lambda: runtime_home))
    assert ui.shared_endpoint() == expected


@pytest.mark.parametrize("contents", ["null", "[]", "invalid", '{"socket":123,"token":"x"}', "x" * 4097])
def test_invalid_shared_file_does_not_supply_an_endpoint(plugin, monkeypatch, tmp_path, contents):
    ui = _mod(plugin, "ui")
    directory = tmp_path / "herald-os"
    directory.mkdir()
    (directory / "control.json").write_text(contents, encoding="utf-8")
    monkeypatch.setattr(ui, "hermes_home", lambda: tmp_path)
    assert ui.shared_endpoint() == ("", "")


def test_partial_environment_does_not_silently_use_another_endpoint(plugin, monkeypatch):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "tcp://127.0.0.1:1234")
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    monkeypatch.setattr(ui, "shared_endpoint", lambda: ("tcp://127.0.0.1:5678", "other"))
    with pytest.raises(ui.ShellUnavailable):
        ui.control_endpoint()


def test_oversized_request_is_rejected_before_connecting(plugin, shell, monkeypatch):
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "MAX_REQUEST_BYTES", 1024)
    with pytest.raises(RuntimeError, match="request is too large"):
        ui.request({"cmd": "ui", "args": {"text": "x" * 1024}})
    assert not shell.requests


def test_inline_image_larger_than_one_mib_crosses_the_real_transport(plugin, shell):
    ui = _mod(plugin, "ui")
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><desc>' + 'x' * (1024 * 1024) + '</desc></svg>'
    source = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
    ui.run_command("canvas.addLayer", {"source": source})
    assert shell.requests[-1]["args"]["source"] == source
    # This verifies framing; real Canvas rendering and maximum-size qualification are separate.


@pytest.mark.parametrize("wire,message", [
    (b"", "empty reply"), (b'{"ok":true}', "incomplete"),
    (b'not-json\n', "malformed JSON"),
    (b'\xff\n', "malformed JSON"), (b'[]\n', "unexpected reply"),
])
def test_bad_reply_is_reported_and_connection_closed(plugin, monkeypatch, wire, message, legacy_socket_transport):
    ui = _mod(plugin, "ui")
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(2.0)
    closed = threading.Event()
    def answer():
        try:
            conn, _ = server.accept()
            with conn:
                conn.settimeout(2.0)
                data = b""
                while b"\n" not in data:
                    data += conn.recv(65536)
                assert json.loads(data)["cmd"] == "auth"
                conn.sendall(b'{"ok":true}\n')
                data = b""
                while b"\n" not in data:
                    data += conn.recv(65536)
                conn.sendall(wire)
                conn.shutdown(socket.SHUT_WR)
                if conn.recv(1) == b"":
                    closed.set()
        finally:
            server.close()
    thread = threading.Thread(target=answer, daemon=True)
    thread.start()
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", f"tcp://127.0.0.1:{server.getsockname()[1]}")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "test-token")
    try:
        with pytest.raises(RuntimeError, match=message):
            ui.request({"cmd": "ui-state"}, timeout=1.0)
    finally:
        thread.join(timeout=3.0)
        server.close()
    assert not thread.is_alive()
    assert closed.is_set()


class ReplySocket:
    """Controllable network boundary for size and whole-request deadline regressions."""

    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.closed = False
        self.timeouts = []
        self.sent = b""

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def connect(self, address):
        assert address == ("127.0.0.1", 1234)

    def sendall(self, data):
        self.sent = data

    def recv(self, count):
        part = next(self.chunks, b"")
        assert len(part) <= count
        return part

    def close(self):
        self.closed = True


def test_response_size_bound_and_multiple_frames(plugin, monkeypatch, legacy_socket_transport):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "tcp://127.0.0.1:1234")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "test-token")
    monkeypatch.setattr(ui, "MAX_REPLY_BYTES", 8)
    large = ReplySocket([b'{"ok":true}\n', b"123456789"])
    monkeypatch.setattr(ui.socket, "socket", lambda *_: large)
    with pytest.raises(RuntimeError, match="reply is too large"):
        ui.request({"cmd": "ui-state"})
    assert large.closed
    multiple = ReplySocket([b'{"ok":true}\n', b"{}\n{}\n"])
    monkeypatch.setattr(ui.socket, "socket", lambda *_: multiple)
    with pytest.raises(RuntimeError, match="multiple reply"):
        ui.request({"cmd": "ui-state"})
    assert multiple.closed


def test_total_deadline_is_not_extended_by_partial_replies(plugin, monkeypatch, legacy_socket_transport):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "tcp://127.0.0.1:1234")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "test-token")
    clock = iter([0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 11.0, 13.0])
    monkeypatch.setattr(ui, "time", SimpleNamespace(monotonic=lambda: next(clock)))
    slow = ReplySocket([b'{"ok":true}\n', b"{", b'"ok":'])
    monkeypatch.setattr(ui.socket, "socket", lambda *_: slow)
    with pytest.raises(RuntimeError, match="timed out"):
        ui.request({"cmd": "ui-state"}, timeout=12.0)
    assert slow.timeouts == [5.0, 5.0, 5.0, 12.0, 11.0, 1.0]
    assert slow.closed


@pytest.mark.parametrize("explicit", [False, True])
def test_caller_and_default_canvas_deadline_are_preserved(plugin, monkeypatch, explicit, legacy_socket_transport):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "tcp://127.0.0.1:1234")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "test-token")
    clock = iter([0.0, 0.0, 0.0, 0.0, 0.0, 89.0])
    monkeypatch.setattr(ui, "time", SimpleNamespace(monotonic=lambda: next(clock)))
    canvas = ReplySocket([b'{"ok":true}\n', b'{"ok":true}\n'])
    monkeypatch.setattr(ui.socket, "socket", lambda *_: canvas)
    assert ui.run_command("canvas.render", **({"timeout": 100.0} if explicit else {})) == {"ok": True}
    assert canvas.timeouts == [5.0, 5.0, 5.0, 100.0, 11.0]
    assert canvas.closed


def test_stale_endpoint_is_shell_unavailable(plugin, monkeypatch, legacy_socket_transport):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "tcp://127.0.0.1:1234")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "test-token")
    stale = ReplySocket([])
    def refused(_address):
        raise ConnectionRefusedError("refused")
    monkeypatch.setattr(stale, "connect", refused)
    monkeypatch.setattr(ui.socket, "socket", lambda *_: stale)
    with pytest.raises(ui.ShellUnavailable, match="no longer listening"):
        ui.request({"cmd": "ui-state"})
    assert stale.closed

@pytest.mark.parametrize("endpoint", [
    "tcp://127.0.0.1:1234", "/tmp/herald.sock",
    r"\\remote\pipe\herald-os-1234-abcd-" + "a" * 32,
])
def test_windows_rejects_nonpipe_or_remote_endpoint_before_connect(plugin, monkeypatch, endpoint):
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "WINDOWS", True)
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "never-send-this-token")
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid Windows endpoint reached a transport constructor")
    monkeypatch.setattr(ui.socket, "socket", forbidden)
    monkeypatch.setattr(ui, "WindowsPipe", forbidden)
    with pytest.raises(ui.ShellUnavailable):
        ui.request({"cmd": "ui-state"})


def test_mocked_windows_pipe_preserves_auth_then_request(plugin, monkeypatch):
    """Protocol wiring only; not native identity or ACL qualification."""
    ui = _mod(plugin, "ui")
    endpoint = r"\\.\pipe\herald-os-1234-abcd-" + "a" * 32
    monkeypatch.setattr(ui, "WINDOWS", True)
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "test-token")
    class PipeReply(ReplySocket):
        def __init__(self):
            super().__init__([b'{"ok":true}\n', b'{"ok":true,"result":{"page":"overview"}}\n'])
            self.connected, self.frames = [], []
        def connect(self, address):
            self.connected.append(address)
        def sendall(self, data):
            self.frames.append(json.loads(data))
    pipe = PipeReply()
    monkeypatch.setattr(ui, "WindowsPipe", lambda: pipe)
    def no_socket(*args, **kwargs):
        pytest.fail("Windows pipe request tried a socket transport")
    monkeypatch.setattr(ui.socket, "socket", no_socket)
    assert ui.request({"cmd": "ui-state"}) == {"ok": True, "result": {"page": "overview"}}
    assert pipe.connected == [endpoint]
    assert pipe.frames == [{"cmd": "auth", "token": "test-token"}, {"cmd": "ui-state", "token": "test-token"}]
    assert pipe.closed


@pytest.mark.parametrize("wait_seconds", [6.0, 10.0])
def test_windows_busy_wait_uses_request_deadline_then_bounded_auth(plugin, monkeypatch, wait_seconds):
    ui = _mod(plugin, "ui")
    endpoint = r"\\.\pipe\herald-os-1234-abcd-" + "a" * 32
    now = [0.0]
    monkeypatch.setattr(ui, "WINDOWS", True)
    monkeypatch.setattr(ui, "time", SimpleNamespace(monotonic=lambda: now[0]))
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "test-token")
    class BusyPipe(ReplySocket):
        def __init__(self):
            super().__init__([b'{"ok":true}\n', b'{"ok":true,"result":"done"}\n'])
            self.frames = []
        def connect(self, address):
            assert address == endpoint
            if self.timeouts[-1] < wait_seconds:
                raise TimeoutError("pipe busy deadline")
            now[0] += wait_seconds
        def sendall(self, data):
            self.frames.append(json.loads(data))
    pipe = BusyPipe()
    monkeypatch.setattr(ui, "WindowsPipe", lambda: pipe)
    assert ui.request({"cmd": "ui-state"}, timeout=12.0) == {"ok": True, "result": "done"}
    auth_remaining = min(5.0, 12.0 - wait_seconds)
    assert pipe.timeouts == [12.0, auth_remaining, auth_remaining, 12.0 - wait_seconds, 12.0 - wait_seconds]
    assert pipe.frames == [{"cmd": "auth", "token": "test-token"}, {"cmd": "ui-state", "token": "test-token"}]
    assert pipe.closed


def test_windows_busy_wait_cannot_extend_the_total_deadline(plugin, monkeypatch):
    ui = _mod(plugin, "ui")
    endpoint = r"\\.\pipe\herald-os-1234-abcd-" + "a" * 32
    now = [0.0]
    monkeypatch.setattr(ui, "WINDOWS", True)
    monkeypatch.setattr(ui, "time", SimpleNamespace(monotonic=lambda: now[0]))
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "never-send-this-token")
    class ExpiredPipe(ReplySocket):
        def __init__(self):
            super().__init__([])
            self.frames = []
        def connect(self, address):
            assert address == endpoint
            now[0] = 13.0
        def sendall(self, data):
            self.frames.append(data)
    pipe = ExpiredPipe()
    monkeypatch.setattr(ui, "WindowsPipe", lambda: pipe)
    with pytest.raises(RuntimeError, match="timed out"):
        ui.request({"cmd": "ui-state"}, timeout=12.0)
    assert pipe.frames == [] and pipe.closed


def test_mocked_windows_pipe_refusal_sends_no_token_and_has_no_tcp_fallback(plugin, monkeypatch):
    ui = _mod(plugin, "ui")
    endpoint = r"\\.\pipe\herald-os-1234-abcd-" + "a" * 32
    monkeypatch.setattr(ui, "WINDOWS", True)
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "never-send-this-token")
    class RefusingPipe(ReplySocket):
        def __init__(self):
            super().__init__([])
            self.frames = []
        def connect(self, address):
            assert address == endpoint
            raise PermissionError("pipe identity rejected")
        def sendall(self, data):
            self.frames.append(data)
    pipe = RefusingPipe()
    monkeypatch.setattr(ui, "WindowsPipe", lambda: pipe)
    def no_socket(*args, **kwargs):
        pytest.fail("Windows pipe refusal tried a socket fallback")
    monkeypatch.setattr(ui.socket, "socket", no_socket)
    with pytest.raises(RuntimeError, match="pipe identity rejected"):
        ui.request({"cmd": "ui-state"})
    assert pipe.frames == [] and pipe.closed
