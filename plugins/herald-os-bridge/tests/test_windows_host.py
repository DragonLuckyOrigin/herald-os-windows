"""Windows host contract tests; provider calls are mocked here."""
import base64
import copy
import importlib
import subprocess
from types import SimpleNamespace
import pytest

@pytest.fixture
def win(plugin):
    return importlib.import_module(plugin.__name__ + ".bridge.host.windows")

def sample():
    return {"os": "Windows 11", "build": "26100", "hostname": "DESKTOP", "arch": "64-bit",
            "chip": "Test CPU", "cpu_cores": 8, "memory_total_bytes": 8192, "memory_used_bytes": 2048,
            "load_average": None, "uptime_seconds": 12.5, "user": "Example", "home": r"C:\Users\Example",
            "disks": [{"mount": "C:\\", "total_bytes": 1000, "used_bytes": 400, "free_bytes": 600}], "battery": []}

@pytest.fixture
def runner(win, monkeypatch):
    calls = []
    answer = SimpleNamespace(returncode=0, stdout='{"value":"Grüße"}'.encode(), stderr=b"")
    answer.response = answer
    class Executable:
        def __str__(self): return r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        def is_file(self): return True
    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        if isinstance(answer.response, BaseException): raise answer.response
        return answer.response
    monkeypatch.setattr(win, "_powershell", lambda: Executable())
    monkeypatch.setattr(win, "os", SimpleNamespace(name="nt", environ={"SystemRoot": r"C:\Windows", "PSModulePath": "foreign"}))
    monkeypatch.setattr(win, "subprocess", SimpleNamespace(run=run, DEVNULL=subprocess.DEVNULL, CREATE_NO_WINDOW=0x08000000, TimeoutExpired=subprocess.TimeoutExpired))
    return answer, calls

def test_hidden_constant_query_and_exact_capabilities(win, runner):
    assert win._query("constant") == {"value": "Grüße"}
    argv, kwargs = runner[1][0]
    assert argv[1:5] == ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]
    assert base64.b64decode(argv[5]).decode("utf-16le") == win._PREFIX + "constant"
    assert kwargs["timeout"] == 20 and kwargs["creationflags"] == 0x08000000
    assert not kwargs.get("shell", False)
    assert kwargs["env"]["PSModulePath"] == r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules"
    assert win._PREFIX.startswith("$env:PSModulePath=$PSHOME+'\\Modules';")
    host = win.WindowsHost()
    assert not host.available()
    assert host.supports("system_info") and host.supports("system_processes")
    for name in ("system_files", "system_kill_process", "system_control", "system_apps", "os_ui"):
        assert not host.supports(name)

@pytest.mark.parametrize("root", ["", r"C:Windows", r"\Windows", r"\\server\Windows", r"\\?\C:\Windows", "//server/Windows"])
def test_system_root_must_be_a_local_drive_before_probe(win, monkeypatch, root):
    monkeypatch.setattr(win, "os", SimpleNamespace(name="nt", environ={"SystemRoot": root}))
    monkeypatch.setattr(win.Path, "is_file", lambda _: pytest.fail("invalid system root reached filesystem"))
    with pytest.raises(win.HostNotSupported):
        win._powershell()
    assert not win.WindowsHost().supports("system_info")

@pytest.mark.parametrize("response", [
    SimpleNamespace(returncode=5, stdout=b"", stderr=b"private-detail"),
    SimpleNamespace(returncode=0, stdout=b"\xff", stderr=b""),
    SimpleNamespace(returncode=0, stdout=b"[]", stderr=b""),
    SimpleNamespace(returncode=0, stdout=b"{", stderr=b""),
    OSError("private-detail"), subprocess.TimeoutExpired("powershell", 20)])
def test_provider_failures_do_not_echo_details(win, runner, response):
    runner[0].response = response
    with pytest.raises(win.HostNotSupported) as error: win._query("constant")
    assert "private-detail" not in str(error.value)

def test_system_contract_and_battery(win, monkeypatch):
    raw = sample()
    monkeypatch.setattr(win, "_query", lambda _: copy.deepcopy(raw))
    assert win.WindowsHost().system_info()["battery"] is None
    raw["battery"] = [{"EstimatedChargeRemaining": 73, "BatteryStatus": 6}]
    assert win.WindowsHost().system_info()["battery"] == {"percent": 73, "state": "charging"}

@pytest.mark.parametrize("key,value", [
    ("os", ""), ("cpu_cores", 0), ("memory_total_bytes", 0), ("memory_used_bytes", 10000),
    ("uptime_seconds", float("nan")), ("load_average", [0, 0, 0]), ("disks", None),
    ("battery", [{"EstimatedChargeRemaining": 101, "BatteryStatus": 6}])])
def test_invalid_system_data_fails(win, monkeypatch, key, value):
    raw = sample(); raw[key] = value
    monkeypatch.setattr(win, "_query", lambda _: raw)
    with pytest.raises(win.HostNotSupported): win.WindowsHost().system_info()

def process(pid=10, cpu=80, rss=100, command=r"C:\Tools\Editor.exe"):
    return {"pid": pid, "ppid": 1, "command": command, "cpu_percent": cpu, "mem_percent": 2, "rss_bytes": rss}

def test_process_ranking_search_and_native_basename(win, monkeypatch):
    monkeypatch.setattr(win, "_query", lambda _: {"rows": [process(), process(20, 10, 900, r"C:\Program Files\Other.exe")]})
    host = win.WindowsHost()
    assert host.list_processes("cpu", 1)[0].pid == 10
    assert host.list_processes("memory", 1)[0].pid == 20
    assert host.find_processes("EDITOR", 10)[0].to_dict()["name"] == "Editor.exe"

@pytest.mark.parametrize("key,value", [("pid", True), ("pid", 1.5), ("ppid", -1), ("cpu_percent", float("nan")),
    ("cpu_percent", 101), ("mem_percent", -1), ("rss_bytes", float("inf")), ("command", ""), ("command", "x" * 1025)])
def test_invalid_process_data_fails(win, monkeypatch, key, value):
    row = process(); row[key] = value
    monkeypatch.setattr(win, "_query", lambda _: {"rows": [row]})
    with pytest.raises(win.HostNotSupported): win.WindowsHost().list_processes("cpu", 10)

@pytest.mark.parametrize("rows", [None, {}, ["bad"], [None]])
def test_invalid_envelopes_fail(win, monkeypatch, rows):
    monkeypatch.setattr(win, "_query", lambda _: {"rows": rows})
    with pytest.raises(win.HostNotSupported): win.WindowsHost().list_processes("cpu", 10)

def test_ports_filter_and_preserve_tcp_udp(win, monkeypatch):
    tcp = {"pid": 10, "port": 3000, "protocol": "tcp", "command": "server.exe"}
    monkeypatch.setattr(win, "_query", lambda _: {"rows": [tcp, tcp.copy(), {**tcp, "protocol": "udp"}, {**tcp, "port": 3001}]})
    assert {(r.pid, r.port, r.protocol) for r in win.WindowsHost().listeners_on_port(3000)} == {(10, 3000, "tcp"), (10, 3000, "udp")}

@pytest.mark.parametrize("port", [True, 0, -1, 65536, "3000", 3.5])
def test_invalid_port_never_queries(win, monkeypatch, port):
    monkeypatch.setattr(win, "_query", lambda _: pytest.fail("invalid port reached provider"))
    with pytest.raises(ValueError): win.WindowsHost().listeners_on_port(port)

def test_unsupported_operations_stay_unavailable(win):
    host = win.WindowsHost()
    for name, args in [("kill", (12, False)), ("trash", ([],)), ("lock_screen", ()), ("set_wifi_power", (True,)), ("open_app", ("Example",)), ("network_status", ())]:
        with pytest.raises(win.HostNotSupported): getattr(host, name)(*args)
