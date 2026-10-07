using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ExecutionHost {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int Size; public string Reserved; public string Desktop; public string Title; public uint X; public uint Y; public uint XSize; public uint YSize; public uint XChars; public uint YChars; public uint Fill; public uint Flags; public short Show; public short ReservedSize; public IntPtr ReservedData; public IntPtr Input; public IntPtr Output; public IntPtr Error; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process; public IntPtr Thread; public uint Pid; public uint Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime; public long JobTime; public uint Flags; public UIntPtr Minimum; public UIntPtr Maximum; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority; public uint Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations; public ulong WriteOperations; public ulong OtherOperations; public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory; public UIntPtr JobMemory; public UIntPtr PeakProcessMemory; public UIntPtr PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime; public long KernelTime; public long PeriodUserTime; public long PeriodKernelTime; public uint Faults; public uint TotalProcesses; public uint ActiveProcesses; public uint TerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low; public uint High; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static readonly object OutputLock = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 16 };
    static readonly BlockingCollection<Dictionary<string, object>> InputQueue = new BlockingCollection<Dictionary<string, object>>(64);
    static IntPtr Job;
    static FileStream Input;
    static volatile bool Failed;
    static volatile bool Settled;
    static string Id;

    static void Check(bool success, string action) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), action); }
    static void Send(string kind, params object[] values) {
        var message = new Dictionary<string, object> { { "version", 1 }, { "type", kind }, { "id", Id } };
        for (int i = 0; i < values.Length; i += 2) message.Add((string)values[i], values[i + 1]);
        lock (OutputLock) { Console.Out.WriteLine(Json.Serialize(message)); Console.Out.Flush(); }
    }
    static Dictionary<string, object> Read() {
        var line = new StringBuilder();
        while (true) {
            int value = Console.In.Read();
            if (value < 0) { if (line.Length == 0) return null; throw new InvalidDataException("Incomplete control frame"); }
            if (value == '\n') break;
            if (line.Length >= 1048576) throw new InvalidDataException("Control frame byte limit exceeded");
            line.Append((char)value);
        }
        var frame = Json.DeserializeObject(line.ToString()) as Dictionary<string, object>;
        if (frame == null || !frame.ContainsKey("version") || Convert.ToInt32(frame["version"]) != 1) throw new InvalidDataException("Unsupported control protocol");
        return frame;
    }
    static string Text(Dictionary<string, object> frame, string key) {
        object value;
        if (!frame.TryGetValue(key, out value) || !(value is string) || ((string)value).IndexOf('\0') >= 0) throw new InvalidDataException("Invalid " + key);
        return (string)value;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(ch);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }
    static FileStream Stream(IntPtr handle, FileAccess access) { return new FileStream(new SafeFileHandle(handle, true), access, 4096, false); }
    static Thread Pump(FileStream stream, string kind) {
        var thread = new Thread(() => {
            try {
                using (stream) {
                    var bytes = new byte[4096];
                    int count;
                    while ((count = stream.Read(bytes, 0, bytes.Length)) != 0) Send(kind, "data", Convert.ToBase64String(bytes, 0, count));
                }
            } catch (Exception error) { Fail(error); }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
    static void Kill() { if (Job != IntPtr.Zero && !Settled) Check(TerminateJobObject(Job, 137), "TerminateJobObject"); }
    static void Fail(Exception error) {
        if (Settled) return;
        Failed = true;
        try { Kill(); } catch {}
        try { Send("error", "message", error.Message); } catch {}
    }
    static void Control() {
        try {
            while (!Settled) {
                var frame = Read();
                if (frame == null) { Kill(); return; }
                if (Text(frame, "id") != Id) throw new InvalidDataException("Control identity mismatch");
                var type = Text(frame, "type");
                if (type == "stop") Kill();
                else if (type == "stdin" || type == "stdinEnd") {
                    if (!InputQueue.TryAdd(frame)) throw new InvalidDataException("Input queue capacity exceeded");
                } else throw new InvalidDataException("Unsupported control command");
            }
        } catch (Exception error) { Fail(error); }
    }
    static void WriteInput() {
        try {
            foreach (var frame in InputQueue.GetConsumingEnumerable()) {
                if (Text(frame, "type") == "stdinEnd") { Input.Dispose(); Send("stdinAck", "sequence", frame["sequence"]); return; }
                var data = Convert.FromBase64String(Text(frame, "data"));
                if (data.Length > 65536) throw new InvalidDataException("Input frame byte limit exceeded");
                Input.Write(data, 0, data.Length);
                Input.Flush();
                Send("stdinAck", "sequence", frame["sequence"]);
            }
        } catch (Exception error) { if (!Settled) { try { Send("stdinError", "message", error.Message); } catch {} } }
    }
    static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        IntPtr childInput = IntPtr.Zero, childOutput = IntPtr.Zero, childError = IntPtr.Zero;
        IntPtr parentInput = IntPtr.Zero, parentOutput = IntPtr.Zero, parentError = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool assigned = false;
        bool started = false;
        try {
            Send("hello", "implementation", "windows-job-v1");
            var frame = Read();
            if (frame == null) throw new InvalidDataException("Expected spawn command");
            Id = Text(frame, "id");
            if (Text(frame, "type") == "stop") throw new OperationCanceledException("Cancelled before worker creation");
            if (Text(frame, "type") != "spawn") throw new InvalidDataException("Expected spawn command");
            var executable = Text(frame, "executable");
            var cwd = Text(frame, "cwd");
            var args = frame["args"] as object[];
            var env = frame["env"] as Dictionary<string, object>;
            int processLimit = Convert.ToInt32(frame["processLimit"]);
            if (args == null || env == null || processLimit < 1 || Id.Length > 128 || !Path.IsPathRooted(executable) || !Directory.Exists(cwd)) throw new InvalidDataException("Invalid spawn configuration");
            var command = new StringBuilder(Quote(executable));
            object verbatim;
            bool rawArguments = frame.TryGetValue("windowsVerbatimArguments", out verbatim) && verbatim is bool && (bool)verbatim;
            foreach (object arg in args) {
                if (!(arg is string) || ((string)arg).IndexOf('\0') >= 0) throw new InvalidDataException("Invalid argument");
                command.Append(' ').Append(rawArguments ? (string)arg : Quote((string)arg));
            }
            if (command.Length >= 32767) throw new InvalidDataException("Windows command line limit exceeded");
            var keys = new List<string>(env.Keys);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            var environmentText = new StringBuilder();
            foreach (string key in keys) {
                if (key.Length == 0 || key.IndexOfAny(new char[] { '=', '\0' }) >= 0) throw new InvalidDataException("Invalid environment key");
                environmentText.Append(key).Append('=').Append(Text(env, key)).Append('\0');
            }
            environmentText.Append('\0');
            if (keys.Count == 0) environmentText.Append('\0');
            environment = Marshal.StringToHGlobalUni(environmentText.ToString());
            Job = CreateJobObjectW(IntPtr.Zero, null);
            Check(Job != IntPtr.Zero, "CreateJobObjectW");
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000 | 0x8;
            limits.Basic.ActiveLimit = (uint)processLimit;
            Check(SetInformationJobObject(Job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
            var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
            Check(CreatePipe(out childInput, out parentInput, ref security, 0), "Create input pipe");
            Check(CreatePipe(out parentOutput, out childOutput, ref security, 0), "Create output pipe");
            Check(CreatePipe(out parentError, out childError, ref security, 0), "Create error pipe");
            Check(SetHandleInformation(parentInput, 1, 0), "Protect parent input");
            Check(SetHandleInformation(parentOutput, 1, 0), "Protect parent output");
            Check(SetHandleInformation(parentError, 1, 0), "Protect parent error");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "Initialize attributes");
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, childInput); Marshal.WriteIntPtr(handles, IntPtr.Size, childOutput); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, childError);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Set inherited handles");
            var startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx)); startup.Startup.Flags = 0x100;
            startup.Startup.Input = childInput; startup.Startup.Output = childOutput; startup.Startup.Error = childError; startup.Attributes = attributes;
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x400 | 0x80000 | 0x08000000, environment, cwd, ref startup, out process), "CreateProcessW suspended");
            Check(AssignProcessToJobObject(Job, process.Process), "AssignProcessToJobObject");
            assigned = true;
            bool member;
            Check(IsProcessInJob(process.Process, Job, out member) && member, "Confirm job membership");
            FileTime creation, exit, kernel, user;
            Check(GetProcessTimes(process.Process, out creation, out exit, out kernel, out user), "Read process identity");
            ulong ticks = ((ulong)creation.High << 32) | creation.Low;
            CloseHandle(childInput); childInput = IntPtr.Zero; CloseHandle(childOutput); childOutput = IntPtr.Zero; CloseHandle(childError); childError = IntPtr.Zero;
            Input = Stream(parentInput, FileAccess.Write); parentInput = IntPtr.Zero;
            var output = Pump(Stream(parentOutput, FileAccess.Read), "stdout"); parentOutput = IntPtr.Zero;
            var errorOutput = Pump(Stream(parentError, FileAccess.Read), "stderr"); parentError = IntPtr.Zero;
            var writer = new Thread(WriteInput); writer.IsBackground = true; writer.Start();
            Check(ResumeThread(process.Thread) != 0xffffffff, "ResumeThread");
            Send("started", "pid", process.Pid, "birthId", (ticks + 504911232000000000UL).ToString(), "accounting", "contained", "containment", "windows-job");
            started = true;
            var control = new Thread(Control); control.IsBackground = true; control.Start();
            bool rootExited = false;
            while (true) {
                if (!rootExited && WaitForSingleObject(process.Process, 0) == 0) {
                    uint code;
                    Check(GetExitCodeProcess(process.Process, out code), "Read exit code");
                    rootExited = true;
                    Send("exited", "exitCode", code);
                }
                Accounting accounting;
                Check(QueryInformationJobObject(Job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Read job accounting");
                if (rootExited && accounting.ActiveProcesses == 0) {
                    Settled = true;
                    InputQueue.CompleteAdding();
                    Input.Dispose();
                    if (!output.Join(5000) || !errorOutput.Join(5000)) throw new IOException("Worker output handles did not physically close");
                    Send("settled", "activeProcesses", 0, "containment", "windows-job");
                    return Failed ? 1 : 0;
                }
                Thread.Sleep(10);
            }
        } catch (Exception error) {
            Failed = true;
            try { if (assigned) Kill(); else if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 137); } catch {}
            try { Send("error", "message", error.Message); } catch {}
            if (!started) {
                try {
                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (true) {
                        bool rootClosed = process.Process == IntPtr.Zero || WaitForSingleObject(process.Process, 0) == 0;
                        Accounting accounting;
                        bool jobEmpty = Job == IntPtr.Zero || (QueryInformationJobObject(Job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) && accounting.ActiveProcesses == 0);
                        if (rootClosed && jobEmpty) { Send("launchSettled", "activeProcesses", 0, "launchFailed", true); break; }
                        if (DateTime.UtcNow >= deadline) break;
                        Thread.Sleep(10);
                    }
                } catch {}
            }
            return 1;
        } finally {
            if (Job != IntPtr.Zero) CloseHandle(Job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            foreach (var handle in new[] { childInput, childOutput, childError, parentInput, parentOutput, parentError }) if (handle != IntPtr.Zero) CloseHandle(handle);
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
}
