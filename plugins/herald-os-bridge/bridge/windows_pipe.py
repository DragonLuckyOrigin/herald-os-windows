"""Local Windows control channel with pre-authentication process/ACL verification.

The trusted environment/private control publication selects the endpoint. Its PID and
creation time bind it to that process; they are not a code-signing certificate.
Only Python's standard library is used. No TCP or generic-access fallback is allowed.
"""
from __future__ import annotations

import ctypes
import math
import os
import re
import time
from ctypes import wintypes as w

_NAME = re.compile(r"\\\\\.\\pipe\\herald-os-([1-9][0-9]*)-([0-9a-f]+)-([0-9a-f]{32})")
_ACCESS = 0x12019B  # Excludes FILE_CREATE_PIPE_INSTANCE, unlike GENERIC_WRITE.
_PENDING, _CONNECTED, _ABORTED = 997, 535, 995
_INVALID = ctypes.c_void_p(-1).value


def valid_pipe_name(endpoint: str) -> bool:
    if not isinstance(endpoint, str) or len(endpoint) > 256:
        return False
    match = _NAME.fullmatch(endpoint)
    return match is not None and int(match[1]) <= 0xffffffff and int(match[2], 16) <= 0xffffffffffffffff


class _Overlapped(ctypes.Structure):
    _fields_ = [("internal", ctypes.c_size_t), ("internal_high", ctypes.c_size_t),
                ("offset", w.DWORD), ("offset_high", w.DWORD), ("event", w.HANDLE)]


class _API:
    def __init__(self) -> None:
        if os.name != "nt" or ctypes.sizeof(ctypes.c_void_p) != 8:
            raise OSError("Windows x64 is required for the protected control pipe")
        root = os.environ.get("SystemRoot", "")
        if not re.match(r"^[A-Za-z]:[\\/]", root):
            raise OSError("An absolute Windows system directory is required")
        kernel = ctypes.WinDLL(os.path.join(root, "System32", "kernel32.dll"), use_last_error=True)
        security = ctypes.WinDLL(os.path.join(root, "System32", "advapi32.dll"), use_last_error=True)
        pointer = ctypes.c_void_p
        pvoid, pdword = ctypes.POINTER(pointer), ctypes.POINTER(w.DWORD)

        def bind(library, name, result, args):
            function = getattr(library, name)
            function.restype, function.argtypes = result, args
            return function

        self.open = bind(kernel, "CreateFileW", w.HANDLE, [w.LPCWSTR, w.DWORD, w.DWORD, pointer, w.DWORD, w.DWORD, w.HANDLE])
        self.close = bind(kernel, "CloseHandle", w.BOOL, [w.HANDLE])
        self.event = bind(kernel, "CreateEventW", w.HANDLE, [pointer, w.BOOL, w.BOOL, pointer])
        self.read = bind(kernel, "ReadFile", w.BOOL, [w.HANDLE, pointer, w.DWORD, pointer, pointer])
        self.write = bind(kernel, "WriteFile", w.BOOL, [w.HANDLE, pointer, w.DWORD, pointer, pointer])
        self.wait = bind(kernel, "WaitForSingleObject", w.DWORD, [w.HANDLE, w.DWORD])
        self.result = bind(kernel, "GetOverlappedResult", w.BOOL, [w.HANDLE, pointer, pdword, w.BOOL])
        self.cancel = bind(kernel, "CancelIoEx", w.BOOL, [w.HANDLE, pointer])
        self.server_pid = bind(kernel, "GetNamedPipeServerProcessId", w.BOOL, [w.HANDLE, pdword])
        self.process = bind(kernel, "OpenProcess", w.HANDLE, [w.DWORD, w.BOOL, w.DWORD])
        self.times = bind(kernel, "GetProcessTimes", w.BOOL, [w.HANDLE, pointer, pointer, pointer, pointer])
        self.token = bind(security, "OpenProcessToken", w.BOOL, [w.HANDLE, w.DWORD, pvoid])
        self.token_info = bind(security, "GetTokenInformation", w.BOOL, [w.HANDLE, ctypes.c_int, pointer, w.DWORD, pdword])
        self.sid_string = bind(security, "ConvertSidToStringSidW", w.BOOL, [pointer, pvoid])
        self.local_free = bind(kernel, "LocalFree", pointer, [pointer])
        self.from_sddl = bind(security, "ConvertStringSecurityDescriptorToSecurityDescriptorW", w.BOOL, [w.LPCWSTR, w.DWORD, pvoid, pointer])
        self.security = bind(security, "GetSecurityInfo", w.DWORD, [w.HANDLE, ctypes.c_int, w.DWORD, pvoid, pointer, pointer, pointer, pvoid])
        self.dacl = bind(security, "GetSecurityDescriptorDacl", w.BOOL, [pointer, ctypes.POINTER(w.BOOL), pvoid, ctypes.POINTER(w.BOOL)])
        self.control = bind(security, "GetSecurityDescriptorControl", w.BOOL, [pointer, ctypes.POINTER(w.WORD), pdword])

    @staticmethod
    def checked(ok) -> None:
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())

    def sid(self, pointer) -> str:
        text = ctypes.c_void_p()
        self.checked(self.sid_string(pointer, ctypes.byref(text)))
        try:
            return ctypes.wstring_at(text)
        finally:
            self.local_free(text)

    def identity(self, process) -> tuple[str, str]:
        token = ctypes.c_void_p()
        self.checked(self.token(process, 8, ctypes.byref(token)))
        try:
            def info(kind):
                needed = w.DWORD()
                self.token_info(token, kind, None, 0, ctypes.byref(needed))
                if not 0 < needed.value <= 1024 * 1024:
                    raise OSError("Invalid process-token size")
                data = ctypes.create_string_buffer(needed.value)
                self.checked(self.token_info(token, kind, data, len(data), ctypes.byref(needed)))
                return data

            user_data = info(1)
            user = self.sid(ctypes.c_void_p.from_buffer(user_data).value)
            groups = info(2)
            count = w.DWORD.from_buffer(groups).value
            if 8 + count * 16 > len(groups):
                raise OSError("Invalid process-token groups")
            logon = ""
            for index in range(count):
                offset = 8 + index * 16
                if w.DWORD.from_buffer(groups, offset + 8).value & 0xC0000000 == 0xC0000000:
                    logon = self.sid(ctypes.c_void_p.from_buffer(groups, offset).value)
            if not re.fullmatch(r"S-1-5-5-\d+-\d+", logon):
                raise OSError("No interactive logon identity is available")
            return user, logon
        finally:
            self.close(token)

    def acl(self, descriptor) -> bytes:
        present, defaulted, pointer = w.BOOL(), w.BOOL(), ctypes.c_void_p()
        self.checked(self.dacl(descriptor, ctypes.byref(present), ctypes.byref(pointer), ctypes.byref(defaulted)))
        control, revision = w.WORD(), w.DWORD()
        self.checked(self.control(descriptor, ctypes.byref(control), ctypes.byref(revision)))
        if not present.value or not pointer.value or defaulted.value or not control.value & 0x1000:
            raise OSError("An explicit protected pipe DACL is required")
        size = w.WORD.from_address(pointer.value + 2).value
        if not 8 <= size <= 4096:
            raise OSError("Invalid pipe DACL size")
        return ctypes.string_at(pointer, size)

    def verify(self, handle, endpoint: str) -> None:
        match = _NAME.fullmatch(endpoint)
        if match is None:
            raise OSError("Invalid local control pipe name")
        pid = w.DWORD()
        self.checked(self.server_pid(handle, ctypes.byref(pid)))
        if pid.value != int(match[1]):
            raise OSError("The control pipe belongs to another process")
        process = self.process(0x1000, False, pid.value)  # QUERY_LIMITED_INFORMATION only.
        self.checked(process)
        try:
            created, exited, kernel, user_time = (ctypes.c_uint64() for _ in range(4))
            self.checked(self.times(process, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user_time)))
            if created.value != int(match[2], 16):
                raise OSError("The control pipe process identity is stale")
            user, logon = self.identity(_INVALID)
            if self.identity(process) != (user, logon):
                raise OSError("The control server belongs to another user or logon")
            expected, actual, owner = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
            text = f"O:{user}D:P(A;;RC;;;OW)(A;;0x{_ACCESS:x};;;{logon})(A;;0x1f01ff;;;SY)"
            self.checked(self.from_sddl(text, 1, ctypes.byref(expected), None))
            try:
                code = self.security(handle, 6, 1 | 4, ctypes.byref(owner), None, None, None, ctypes.byref(actual))
                if code:
                    raise ctypes.WinError(code)
                if self.sid(owner) != user or self.acl(actual) != self.acl(expected):
                    raise OSError("The control pipe owner or permissions do not match")
            finally:
                if actual.value:
                    self.local_free(actual)
                self.local_free(expected)
        finally:
            self.close(process)


class WindowsPipe:
    """Small socket-shaped adapter; ui.py retains the existing bounded JSON/auth protocol."""
    def __init__(self) -> None:
        self._api = _API()
        self._handle = None
        self._timeout = 12.0

    def settimeout(self, timeout: float) -> None:
        if not math.isfinite(timeout) or timeout <= 0:
            raise TimeoutError("control pipe deadline expired")
        self._timeout = timeout

    def connect(self, endpoint: str) -> None:
        if not valid_pipe_name(endpoint) or self._handle is not None:
            raise OSError("Invalid local control pipe endpoint or connection state")
        deadline = time.monotonic() + self._timeout
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("control pipe is busy")
            handle = self._api.open(endpoint, _ACCESS, 0, None, 3, 0x40000000 | 0x00100000, None)
            if handle != _INVALID:
                self._handle = handle
                try:
                    # SECURITY_SQOS_PRESENT with SECURITY_ANONYMOUS prevents server impersonation.
                    self._api.verify(handle, endpoint)
                    if time.monotonic() >= deadline:
                        raise TimeoutError("control pipe identity check timed out")
                    return
                except BaseException:
                    self.close()
                    raise
            code = ctypes.get_last_error()
            if code != 231:  # ERROR_PIPE_BUSY: retry opening only, never a sent command.
                raise ctypes.WinError(code)
            time.sleep(min(0.01, max(0, deadline - time.monotonic())))

    def _io(self, count: int, data: bytes | None, deadline: float) -> bytes:
        if self._handle is None:
            raise OSError("The control pipe is not connected")
        api = self._api
        event = api.event(None, True, False, None)
        api.checked(event)
        state = _Overlapped(event=event)
        buffer = ctypes.create_string_buffer(data, count) if data is not None else ctypes.create_string_buffer(count)
        pending = drained = False
        transferred = w.DWORD()
        try:
            function = api.write if data is not None else api.read
            ok = function(self._handle, buffer, count, None, ctypes.byref(state))
            code = 0 if ok else ctypes.get_last_error()
            if code and code != _PENDING:
                if data is None and code in (109, 232, 233):
                    return b""
                raise ctypes.WinError(code)
            pending = True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("control pipe I/O timed out")
            status = api.wait(event, min(0x7FFFFFFF, math.ceil(remaining * 1000)))
            if status == 258:
                raise TimeoutError("control pipe I/O timed out")
            if status != 0:
                raise ctypes.WinError(ctypes.get_last_error())
            ok = api.result(self._handle, ctypes.byref(state), ctypes.byref(transferred), False)
            code = 0 if ok else ctypes.get_last_error()
            drained = code != 996  # ERROR_IO_INCOMPLETE still owns the native buffers.
            if code:
                if data is None and code in (109, 232, 233):
                    return b""
                raise ctypes.WinError(code)
            if data is not None and transferred.value != count:
                raise OSError("Incomplete control pipe write; do not retry the command")
            return buffer.raw[:transferred.value] if data is None else b""
        finally:
            if pending and not drained:
                api.cancel(self._handle, ctypes.byref(state))
                # Cancellation is not completion. Drain before ctypes releases native memory.
                api.result(self._handle, ctypes.byref(state), ctypes.byref(transferred), True)
            api.close(event)

    def sendall(self, data: bytes) -> None:
        deadline = time.monotonic() + self._timeout
        for offset in range(0, len(data), 65536):
            chunk = data[offset:offset + 65536]
            self._io(len(chunk), chunk, deadline)

    def recv(self, count: int) -> bytes:
        return self._io(min(count, 65536), None, time.monotonic() + self._timeout)

    def close(self) -> None:
        if self._handle is not None:
            self._api.close(self._handle)
            self._handle = None
