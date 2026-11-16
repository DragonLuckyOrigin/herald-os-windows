"""Read-only Windows diagnostics. Every other HostAdapter capability remains unavailable."""

from __future__ import annotations

import base64
import json
import math
import os
import re
import subprocess
from pathlib import Path, PureWindowsPath
from typing import Any, Literal, Sequence

from ..documents import DocumentText
from .base import AppInfo, FileSearch, FoundFile, HostAdapter, HostNotSupported, PortListener, ProcessRow

_MESSAGE = "The Herald OS system bridge does not support Windows yet."

_MAX_ROWS = 8192
_MAX_JSON = 16 * 1024 * 1024
_PREFIX = "$env:PSModulePath=$PSHOME+'\\Modules';$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
_SYSTEM = r"""
$os=Get-CimInstance Win32_OperatingSystem
$computer=Get-CimInstance Win32_ComputerSystem
$processors=@(Get-CimInstance Win32_Processor)
$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  @{mount=$_.DeviceID+'\';total_bytes=[double]$_.Size;used_bytes=[double]$_.Size-[double]$_.FreeSpace;free_bytes=[double]$_.FreeSpace}
})
$battery=@(Get-CimInstance Win32_Battery | Select-Object -First 1 -Property EstimatedChargeRemaining,BatteryStatus)
@{os=$os.Caption;build=$os.BuildNumber;hostname=$computer.Name;arch=$os.OSArchitecture;
chip=($processors.Name -join ', ');cpu_cores=[int]$computer.NumberOfLogicalProcessors;
memory_total_bytes=[double]$os.TotalVisibleMemorySize*1024;memory_used_bytes=([double]$os.TotalVisibleMemorySize-[double]$os.FreePhysicalMemory)*1024;
load_average=$null;uptime_seconds=[Math]::Max(0,([DateTime]::Now-$os.LastBootUpTime).TotalSeconds);
disks=$disks;battery=$battery;user=[Environment]::UserName;home=$env:USERPROFILE} | ConvertTo-Json -Compress -Depth 5
"""
_PROCESSES = r"""
$os=Get-CimInstance Win32_OperatingSystem
$cores=[Math]::Max(1,[Environment]::ProcessorCount)
$counters=@{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object {if($null -eq $_.IDProcess -or $null -eq $_.PercentProcessorTime){throw 'Process counters unavailable'}; $counters[[int]$_.IDProcess]=[double]$_.PercentProcessorTime}
$processes=@(Get-CimInstance Win32_Process | Select-Object -First 8193)
if($processes.Count -gt 8192){throw 'Process limit exceeded'}
$rows=@($processes | ForEach-Object {
  if($_.ProcessId -gt 0 -and $counters.ContainsKey([int]$_.ProcessId)) {
    $name=if($_.ExecutablePath){[string]$_.ExecutablePath}else{[string]$_.Name}
    if($name.Length -gt 1024){throw 'Process name limit exceeded'}
    @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;command=$name;user='';
      rss_bytes=[double]$_.WorkingSetSize;cpu_percent=[Math]::Min(100,$counters[[int]$_.ProcessId]/$cores);
      mem_percent=[Math]::Min(100,100*[double]$_.WorkingSetSize/([double]$os.TotalVisibleMemorySize*1024))}
  }
})
if($processes.Count -gt 0 -and $rows.Count -eq 0){throw 'No process performance samples are available'}
@{rows=$rows}|ConvertTo-Json -Compress -Depth 4
"""
_PORTS = r"""
$tcp=@(Get-NetTCPConnection -State Listen | Select-Object -First 8193)
$udp=@(Get-NetUDPEndpoint | Select-Object -First 8193)
if($tcp.Count -gt 8192 -or $udp.Count -gt 8192){throw 'Endpoint limit exceeded'}
$names=@{}; Get-CimInstance Win32_Process | ForEach-Object {$names[[int]$_.ProcessId]=[string]$_.Name}
$rows=@($tcp | Where-Object State -eq Listen | ForEach-Object {@{pid=[int]$_.OwningProcess;port=[int]$_.LocalPort;protocol='tcp';command=$names[[int]$_.OwningProcess];user=''}})
$rows+=@($udp | ForEach-Object {@{pid=[int]$_.OwningProcess;port=[int]$_.LocalPort;protocol='udp';command=$names[[int]$_.OwningProcess];user=''}})
if($rows.Count -gt 8192){throw 'Endpoint limit exceeded'}
@{rows=$rows}|ConvertTo-Json -Compress -Depth 4
"""


def _powershell() -> Path:
    root = os.environ.get("SystemRoot", "")
    if not re.match(r"^[A-Za-z]:[\\/]", root):
        raise HostNotSupported("An absolute Windows system directory is required.")
    return Path(root) / "System32/WindowsPowerShell/v1.0/powershell.exe"


def _query(script: str) -> dict[str, Any]:
    executable = _powershell()
    if os.name != "nt" or not executable.is_file():
        raise HostNotSupported("Built-in Windows PowerShell is unavailable.")
    encoded = base64.b64encode((_PREFIX + script).encode("utf-16le")).decode("ascii")
    env = os.environ.copy()
    env["PSModulePath"] = str(PureWindowsPath(str(executable)).parent / "Modules")
    try:
        result = subprocess.run([str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=20, env=env,
                                creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HostNotSupported("Windows diagnostics could not complete.") from exc
    if result.returncode != 0:
        raise HostNotSupported(f"Windows diagnostics failed (exit {result.returncode}).")
    if len(result.stdout) > _MAX_JSON:
        raise HostNotSupported("Windows diagnostics exceeded the result limit.")
    try:
        value = json.loads(result.stdout.decode("utf-8-sig"))
    except (UnicodeError, ValueError) as exc:
        raise HostNotSupported("Windows diagnostics returned invalid JSON.") from exc
    if not isinstance(value, dict):
        raise HostNotSupported("Windows diagnostics returned an invalid object.")
    return value


def _rows(script: str) -> list[dict[str, Any]]:
    rows = _query(script).get("rows")
    if not isinstance(rows, list) or len(rows) > _MAX_ROWS or not all(isinstance(row, dict) for row in rows):
        raise HostNotSupported("Windows diagnostics returned invalid rows.")
    return rows


def _number(row: dict, key: str, *, integer: bool = False) -> float | int:
    value = row.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (integer and int(value) != value):
        raise HostNotSupported(f"Windows diagnostics returned invalid {key}.")
    return int(value) if integer else float(value)


class WindowsProcessRow(ProcessRow):
    @property
    def name(self) -> str:
        return PureWindowsPath(self.command).name


class WindowsHost(HostAdapter):
    platform = "win32"

    def available(self) -> bool:
        # This adapter is deliberately incomplete; registration queries exact supported tool names.
        return False

    def supports(self, tool: str) -> bool:
        if tool not in {"system_info", "system_processes"} or os.name != "nt":
            return False
        try:
            return _powershell().is_file()
        except HostNotSupported:
            return False

    def system_info(self) -> dict[str, Any]:
        raw = _query(_SYSTEM)
        result = dict(raw)
        for key in ("os", "build", "hostname", "arch", "user", "home"):
            value = raw.get(key)
            if not isinstance(value, str) or not value.strip() or len(value) > 32768:
                raise HostNotSupported(f"Windows diagnostics returned invalid {key}.")
        if raw.get("chip") is not None and not isinstance(raw["chip"], str):
            raise HostNotSupported("Windows diagnostics returned invalid chip.")
        for key in ("cpu_cores", "memory_total_bytes", "memory_used_bytes"):
            result[key] = _number(raw, key, integer=True)
        result["uptime_seconds"] = _number(raw, "uptime_seconds")
        if result["cpu_cores"] < 1 or result["memory_total_bytes"] < 1 or result["memory_used_bytes"] > result["memory_total_bytes"]:
            raise HostNotSupported("Windows diagnostics returned inconsistent system totals.")
        if raw.get("load_average") is not None:
            raise HostNotSupported("Windows does not provide Unix load averages.")
        result["load_average"] = None
        disks = raw.get("disks")
        if not isinstance(disks, list) or len(disks) > 256:
            raise HostNotSupported("Windows diagnostics returned invalid disks.")
        normalized = []
        for disk in disks:
            if not isinstance(disk, dict) or not isinstance(disk.get("mount"), str) or not disk["mount"]:
                raise HostNotSupported("Windows diagnostics returned an invalid disk.")
            values = {key: _number(disk, key, integer=True) for key in ("total_bytes", "used_bytes", "free_bytes")}
            if values["used_bytes"] + values["free_bytes"] != values["total_bytes"]:
                raise HostNotSupported("Windows diagnostics returned inconsistent disk totals.")
            normalized.append({"mount": disk["mount"], **values})
        result["disks"] = normalized
        batteries = raw.get("battery")
        if not isinstance(batteries, list) or len(batteries) > 1:
            raise HostNotSupported("Windows diagnostics returned invalid battery data.")
        result["battery"] = None
        if batteries:
            battery = batteries[0]
            if not isinstance(battery, dict):
                raise HostNotSupported("Windows diagnostics returned invalid battery data.")
            percent = _number(battery, "EstimatedChargeRemaining", integer=True)
            state = _number(battery, "BatteryStatus", integer=True)
            states = {1: "discharging", 2: "AC power", 3: "fully charged", 4: "low", 5: "critical", 6: "charging", 7: "charging", 8: "charging", 9: "charging", 10: "unknown", 11: "partially charged"}
            if percent > 100 or state not in states:
                raise HostNotSupported("Windows diagnostics returned invalid battery status.")
            result["battery"] = {"percent": percent, "state": states[state]}
        return result

    def _process_rows(self) -> list[ProcessRow]:
        processes = []
        for row in _rows(_PROCESSES):
            command = row.get("command")
            if not isinstance(command, str) or not command or len(command) > 1024:
                raise HostNotSupported("Windows diagnostics returned an invalid process name.")
            cpu, memory = _number(row, "cpu_percent"), _number(row, "mem_percent")
            if cpu > 100 or memory > 100:
                raise HostNotSupported("Windows diagnostics returned invalid usage percentages.")
            processes.append(WindowsProcessRow(pid=_number(row, "pid", integer=True), ppid=_number(row, "ppid", integer=True),
                                               user="", cpu_percent=cpu, mem_percent=memory,
                                               rss_bytes=_number(row, "rss_bytes", integer=True), command=command))
        return processes

    def list_processes(self, sort: Literal["cpu", "memory"], limit: int) -> list[ProcessRow]:
        key = (lambda row: row.cpu_percent) if sort == "cpu" else (lambda row: row.rss_bytes)
        return sorted(self._process_rows(), key=key, reverse=True)[:max(1, min(limit, 100))]

    def find_processes(self, name: str, limit: int) -> list[ProcessRow]:
        rows = [row for row in self._process_rows() if name.casefold() in row.command.casefold()]
        return sorted(rows, key=lambda row: row.cpu_percent, reverse=True)[:max(1, min(limit, 100))]

    def listeners_on_port(self, port: int) -> list[PortListener]:
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        unique = {}
        for row in _rows(_PORTS):
            pid, found_port = _number(row, "pid", integer=True), _number(row, "port", integer=True)
            protocol, command = row.get("protocol"), row.get("command") or ""
            if protocol not in ("tcp", "udp") or not 1 <= found_port <= 65535 or not isinstance(command, str) or len(command) > 1024:
                raise HostNotSupported("Windows diagnostics returned an invalid endpoint.")
            if found_port == port:
                unique[(protocol, pid, port)] = PortListener(pid=pid, command=command, user="", port=port, protocol=protocol)
        return list(unique.values())

    def disk_usage(self, path: Path, depth: int, limit: int, timeout: float) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def find_files(self, query: FileSearch) -> list[FoundFile]:
        raise HostNotSupported(_MESSAGE)

    def installed_apps(self) -> list[AppInfo]:
        raise HostNotSupported(_MESSAGE)

    def running_apps(self) -> list[AppInfo]:
        raise HostNotSupported(_MESSAGE)

    def open_app(self, name: str, args: Sequence[str] = ()) -> None:
        raise HostNotSupported(_MESSAGE)

    def open_url(self, url: str, app: str | None = None) -> None:
        raise HostNotSupported(_MESSAGE)

    def open_path(self, path: Path, app: str | None = None) -> None:
        raise HostNotSupported(_MESSAGE)

    def reveal(self, path: Path) -> None:
        raise HostNotSupported(_MESSAGE)

    def quit_app(self, name: str, force: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def read_document(self, path: Path, max_pages: int, ocr: bool) -> DocumentText:
        raise HostNotSupported(_MESSAGE)

    def network_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def bluetooth_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def audio_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def appearance_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def system_logs(self, minutes: int, level: str, process: str | None, limit: int) -> list[str]:
        raise HostNotSupported(_MESSAGE)

    def set_volume(self, percent: int | None, muted: bool | None) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def set_dark_mode(self, enabled: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def open_settings(self, pane: str) -> str:
        raise HostNotSupported(_MESSAGE)

    def lock_screen(self) -> None:
        raise HostNotSupported(_MESSAGE)

    def sleep_display(self) -> None:
        raise HostNotSupported(_MESSAGE)

    def set_wifi_power(self, enabled: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def kill(self, pid: int, force: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def trash(self, paths: Sequence[Path]) -> None:
        raise HostNotSupported(_MESSAGE)

    def notify(self, title: str, body: str) -> None:
        raise HostNotSupported(_MESSAGE)
