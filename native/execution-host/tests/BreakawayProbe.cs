using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class BreakawayProbe {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup { public int Size; public string Reserved; public string Desktop; public string Title; public uint X; public uint Y; public uint Width; public uint Height; public uint XChars; public uint YChars; public uint Fill; public uint Flags; public short Show; public short Bytes; public IntPtr Data; public IntPtr Input; public IntPtr Output; public IntPtr Error; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process; public IntPtr Thread; public uint Pid; public uint Tid; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static int Main(string[] args) {
        var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)) };
        ProcessInfo process;
        var command = new StringBuilder("\"" + args[0] + "\" \"" + args[1] + "\" worker \"" + args[2] + "\"");
        bool accepted = CreateProcessW(args[0], command, IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, Directory.GetCurrentDirectory(), ref startup, out process);
        int error = Marshal.GetLastWin32Error();
        File.WriteAllText(args[2], new JavaScriptSerializer().Serialize(new { accepted = accepted, error = error, childPid = process.Pid }));
        if (accepted) { CloseHandle(process.Thread); CloseHandle(process.Process); }
        return 0;
    }
}
