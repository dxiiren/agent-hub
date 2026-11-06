"""Child-process cleanup for pollers: end every descendant of this process (the SDK's bundled CLI) so none outlives the poll."""
import os, signal, subprocess, sys


def _children_map():
    """{parent_pid: [pid, ...]} of every process; psutil when installed, else toolhelp (Windows) or ps (posix)."""
    m = {}
    try:
        import psutil
        for p in psutil.process_iter(["pid", "ppid"]):
            m.setdefault(p.info["ppid"], []).append(p.info["pid"])
        return m
    except ImportError:
        pass
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class PE(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                        ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260)]
        k = ctypes.windll.kernel32
        k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        snap = k.CreateToolhelp32Snapshot(2, 0)
        e = PE(); e.dwSize = ctypes.sizeof(PE)
        ok = k.Process32First(snap, ctypes.byref(e))
        while ok:
            m.setdefault(e.th32ParentProcessID, []).append(e.th32ProcessID)
            ok = k.Process32Next(snap, ctypes.byref(e))
        k.CloseHandle(snap)
        return m
    for line in subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout.splitlines():
        a = line.split()
        if len(a) == 2:
            m.setdefault(int(a[1]), []).append(int(a[0]))
    return m


def descendants(pid=None):
    m, out, todo = _children_map(), [], [pid or os.getpid()]
    while todo:
        for c in m.get(todo.pop(), []):
            if c not in out:
                out.append(c); todo.append(c)
    return out


def kill_descendants():
    """Kill every descendant of this process, deepest first. Returns the pids it tried."""
    pids = descendants()
    for p in reversed(pids):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/PID", str(p)], capture_output=True)
            else:
                os.kill(p, signal.SIGKILL)
        except Exception:
            pass
    return pids


def die_on_signal():
    """SIGTERM/SIGINT/SIGBREAK -> SystemExit so the caller's finally blocks (and kill_descendants) run."""
    def h(*_):
        sys.exit(143)
    for n in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, n):
            try:
                signal.signal(getattr(signal, n), h)
            except Exception:
                pass
