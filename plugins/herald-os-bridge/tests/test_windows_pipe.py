"""Pure contract tests. Actual DLL, ACL and cancellation qualification is separate."""
import ctypes
import importlib
from types import SimpleNamespace
import pytest

NAME = r"\\.\pipe\herald-os-42-abc-" + "a" * 32

@pytest.fixture
def module(plugin, monkeypatch):
    value = importlib.import_module(plugin.__name__ + ".bridge.windows_pipe")
    monkeypatch.setattr(value.ctypes, "WinError", lambda code=None: OSError(f"win32:{code}"), raising=False)
    return value

class FakeAPI:
    def __init__(self, module):
        self.module, self.error, self.events, self.output = module, 0, [], []
        self.busy, self.verify_error, self.pending, self.wait_status, self.transferred = 0, None, False, 0, 0
        self.short_write = False
    def checked(self, ok):
        if not ok: raise OSError("native query failed")
    def open(self, *args):
        self.events.append(("open", args))
        if self.busy:
            self.busy -= 1; self.error = 231
            return self.module._INVALID
        return 10
    def verify(self, handle, name):
        self.events.append(("verify", handle))
        if self.verify_error: raise self.verify_error
    def close(self, handle): self.events.append(("close", handle)); return True
    def event(self, *_): return 20
    def write(self, handle, buffer, count, unused, state):
        self.events.append(("write", count)); self.output.append(ctypes.string_at(buffer, count))
        self.transferred = count - 1 if self.short_write else count
        self.error = self.module._PENDING if self.pending else 0
        return not self.pending
    def read(self, handle, buffer, count, unused, state):
        self.events.append(("read", count))
        ctypes.memmove(buffer, b"reply\n", 6)
        self.transferred = 6
        self.error = self.module._PENDING if self.pending else 0
        return not self.pending
    def wait(self, event, milliseconds): self.events.append(("wait", milliseconds)); return self.wait_status
    def result(self, handle, state, transferred, wait):
        self.events.append(("result", wait)); transferred._obj.value = self.transferred
        return True
    def cancel(self, handle, state): self.events.append(("cancel", handle)); return True

@pytest.fixture
def fake(module, monkeypatch):
    api = FakeAPI(module)
    monkeypatch.setattr(module, "_API", lambda: api)
    monkeypatch.setattr(module.ctypes, "get_last_error", lambda: api.error, raising=False)
    return api, module.WindowsPipe

@pytest.mark.parametrize("name", ["tcp://127.0.0.1:1234", r"\\remote\pipe\herald-os-42-abc-"+"a"*32,
    NAME+"\\child", NAME+"\n", NAME.replace("-42-", "-0-"), NAME[:-1], None,
    NAME.replace("-42-", "-4294967296-"), NAME.replace("-abc-", "-10000000000000000-")])
def test_local_name_bounds(module, name):
    assert not module.valid_pipe_name(name)
    assert module.valid_pipe_name(NAME)

def test_specific_access_anonymous_sqos_and_idempotent_close(fake):
    api, factory = fake; channel = factory(); channel.connect(NAME)
    args = api.events[0][1]
    assert args[1] == 0x12019B and not args[1] & 4
    assert args[4] == 3 and args[5] == 0x40100000
    assert api.events[1] == ("verify", 10)
    channel.close(); channel.close()
    assert api.events.count(("close", 10)) == 1

def test_identity_refusal_closes_before_data(fake):
    api, factory = fake; api.verify_error = OSError("wrong identity")
    channel = factory()
    with pytest.raises(OSError, match="wrong identity"): channel.connect(NAME)
    assert channel._handle is None and ("close", 10) in api.events and not api.output

@pytest.mark.parametrize("timeout", [0, -1, float("nan"), float("inf")])
def test_invalid_deadline(fake, timeout):
    with pytest.raises(TimeoutError): fake[1]().settimeout(timeout)

def test_busy_retry_preserves_deadline_before_data(module, fake, monkeypatch):
    api, factory = fake; now = [0.0]
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0]+seconds)))
    api.busy = 100; channel = factory(); channel.settimeout(.025)
    with pytest.raises(TimeoutError): channel.connect(NAME)
    assert channel._handle is None and not api.output
    assert not any(e[0] == "verify" for e in api.events)

def test_chunking_and_pending_completion(fake):
    api, factory = fake; channel = factory(); channel.connect(NAME)
    channel.sendall(b"x" * 65543)
    assert list(map(len, api.output)) == [65536, 7]
    api.pending = True
    assert channel.recv(100) == b"reply\n"
    assert ("result", False) in api.events
    channel.close()

def test_cancel_is_drained_before_memory_event_release(fake):
    api, factory = fake; channel = factory(); channel.connect(NAME)
    api.pending = True; api.wait_status = 258
    with pytest.raises(TimeoutError): channel.recv(100)
    assert api.events.index(("cancel", 10)) < api.events.index(("result", True)) < api.events.index(("close", 20))
    channel.close()

def test_partial_write_is_never_replayed(fake):
    api, factory = fake; channel = factory(); channel.connect(NAME); api.short_write = True
    with pytest.raises(OSError, match="do not retry"): channel.sendall(b"command\n")
    assert api.output == [b"command\n"]
    channel.close()
