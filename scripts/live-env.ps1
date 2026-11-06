# Prints the NAMES (never the values) of the environment of a running process of the current user, one per line. Windows, 64-bit process.
# Reads the process's own environment block (PEB -> ProcessParameters -> Environment). Used by `agent-hub doctor` to audit the running daemon.
param([Parameter(Mandatory = $true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HubLiveEnv {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);
  static byte[] Read(IntPtr h, long addr, int n) { var b = new byte[n]; IntPtr got; if (!ReadProcessMemory(h, (IntPtr)addr, b, (IntPtr)n, out got)) throw new Exception("read failed"); return b; }
  public static string[] Names(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
    if (h == IntPtr.Zero) throw new Exception("cannot open process " + pid);
    try {
      var pbi = new byte[48]; int ret;
      if (NtQueryInformationProcess(h, 0, pbi, 48, out ret) != 0) throw new Exception("NtQueryInformationProcess failed");
      long peb = BitConverter.ToInt64(pbi, 8);
      long pp = BitConverter.ToInt64(Read(h, peb + 0x20, 8), 0);
      long env = BitConverter.ToInt64(Read(h, pp + 0x80, 8), 0);
      long size = BitConverter.ToInt64(Read(h, pp + 0x3F0, 8), 0);
      if (size <= 0 || size > 4 * 1024 * 1024) throw new Exception("unexpected environment size");
      string all = Encoding.Unicode.GetString(Read(h, env, (int)size));
      var names = new System.Collections.Generic.List<string>();
      foreach (var kv in all.Split('\0')) { if (kv.Length == 0) continue; int i = kv.IndexOf('=', 1); if (i > 0) names.Add(kv.Substring(0, i)); }
      return names.ToArray();
    } finally { CloseHandle(h); }
  }
}
'@
[HubLiveEnv]::Names($ProcessId) | ForEach-Object { $_ }
