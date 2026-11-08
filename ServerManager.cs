using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace DSH_Desktop;

/// <summary>启动等待的结果。</summary>
public enum ServerReadiness
{
    /// <summary>带 token 的地址已打印，且返回 2xx。</summary>
    Ready,
    /// <summary>子进程提前退出（端口被占、插件报错等）。</summary>
    Exited,
    /// <summary>等到超时，进程还活着但未就绪。</summary>
    TimedOut,
}

/// <summary>
/// 管理 `dsh web` 服务生命周期：定位 dsh、拉起、等待就绪、记录日志、退出时停止。
///
/// 0.2.x 的 dsh 要等 profile 合成、全部插件挂载完才会打印带 token 的地址
/// （<c>dsh-web-app</c> 的 <c>announceReady</c>），所以「打印地址」比 0.1.x 更晚；
/// 刚开机时磁盘和 CPU 被启动项占用，首次启动可能远超旧的 30 秒预算。
///
/// 因此这里负责：
/// - 子进程 stdout/stderr 全量写入 <c>%LOCALAPPDATA%\DSH_Desktop\logs\launch-*.log</c>；
/// - 等待期间同时探测「进程已退出」，失败时能给出真实原因而不是笼统的「未安装」；
/// - 从打印的行里解析**完整 URL**（含实际端口），支持 <c>--port 0</c>；
/// - 启动前先探测首选端口，被占用就直接让系统分配，避免一次注定失败的启动。
/// </summary>
public sealed class ServerManager : IDisposable
{
    /// <summary>保留的尾部日志行数（用于失败提示）。</summary>
    private const int TailLines = 120;
    /// <summary>保留的历史启动日志文件数。</summary>
    private const int KeptLogs = 12;
    /// <summary>`where dsh` 的最长等待：刚开机时 cmd/where 也可能很慢。</summary>
    private static readonly TimeSpan WhereTimeout = TimeSpan.FromSeconds(8);
    /// <summary>npm 生成的 Windows 垫片文件名（.ps1 不能由 cmd 直接执行，故不在其中）。</summary>
    private static readonly string[] ShimNames = { "dsh.cmd", "dsh.exe", "dsh.bat" };

    private static readonly HttpClient Probe = new() { Timeout = TimeSpan.FromSeconds(3) };
    private static readonly Regex TokenUrl = new(@"(https?://[^\s""']*\?token=[^\s&""']+)", RegexOptions.Compiled);

    private readonly object _gate = new();
    private readonly Queue<string> _tail = new();
    private Process? _process;
    private StreamWriter? _log;
    private volatile string? _authUrl;
    private volatile string? _origin;
    private volatile string _probeNote = "";
    private int _exitCode = int.MinValue;
    private volatile bool _disposed;

    /// <summary>带 token 的完整访问地址（token 来自 dsh web 启动时打印的 URL）。</summary>
    public string? AuthUrl => _authUrl;

    /// <summary>服务根地址（scheme://host:port），用于桌面插件的同源判定。</summary>
    public string? Origin => _origin;

    /// <summary>本次启动的日志文件路径（每次 Start 一个文件）。</summary>
    public string LogPath { get; private set; } = "";

    /// <summary>首选端口被占用而改用自动端口时的说明；未发生时为空。</summary>
    public string PortNote { get; private set; } = "";

    /// <summary>子进程退出码；仍在运行时为 null。</summary>
    public int? ExitCode
    {
        get { var code = _exitCode; return code == int.MinValue ? null : code; }
    }

    /// <summary>子进程最近输出的尾部（stdout + stderr，含本类的诊断行）。</summary>
    public string OutputTail
    {
        get { lock (_gate) return string.Join(Environment.NewLine, _tail); }
    }

    /// <summary>失败原因的最终说明，由 <see cref="Explain"/> 写入。</summary>
    public string LastFailure { get; set; } = "";

    /// <summary>拉起 `dsh web`。只负责启动，不等待就绪。</summary>
    /// <param name="port">监听端口；0 表示让系统挑一个空闲端口。</param>
    /// <param name="error">启动前的本地失败原因（找不到 dsh、无法创建进程等）。</param>
    /// <returns>进程是否成功创建。</returns>
    public bool Start(int port, out string error)
    {
        error = "";
        if (_disposed)
        {
            // 窗口已经在关闭：不再拉新进程，避免留下没人收的孤儿 dsh。
            error = "服务管理器已释放，无法再启动 dsh。";
            return false;
        }

        // 上一次进程还活着时先收掉，避免重试路径留下孤儿进程占着端口。
        if (_process is not null) Stop();

        CloseLog();
        ResetState();
        OpenLog();
        Log("---- launch ----");
        Log($"app: {Environment.ProcessPath ?? "(unknown)"}");
        Log($"os: {Environment.OSVersion.VersionString} 64bit={Environment.Is64BitProcess}");
        Log($"DSH_HOME: {DshHome()}");
        Log($"cwd: {WorkspaceDirectory()}");
        Log($"port: {(port == 0 ? "auto" : port.ToString())}");

        var dsh = ResolveDsh();
        if (dsh is null)
        {
            error = "未找到 dsh：PATH 与常见 npm 全局目录（%APPDATA%\\npm 等）里都没有 dsh.cmd。"
                    + "请先执行 npm install -g @deepseek-ai/dsh。";
            return false;
        }
        Log($"dsh: {dsh}");

        if (port != 0 && IsListening(port))
        {
            // 首选端口已被别的进程占用（常见于上次异常退出留下的 dsh）。
            // 直接让系统分配端口，省掉一次注定 EADDRINUSE 的启动和重试等待。
            PortNote = $"端口 {port} 已被占用，改用系统分配的端口";
            Log(PortNote);
            port = 0;
        }

        var psi = new ProcessStartInfo
        {
            // 用 cmd 跑 npm 生成的 dsh.cmd 垫片；/d 跳过 AutoRun 注册表命令。
            FileName = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe",
            Arguments = $"/d /c \"\"{dsh}\" web --no-open --port {port}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = WorkspaceDirectory(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.Environment["DSH_HOME"] = DshHome();

        Process? process;
        try
        {
            process = Process.Start(psi);
        }
        catch (Exception ex)
        {
            error = "无法启动 dsh：" + ex.Message;
            Log("start failed: " + ex);
            return false;
        }
        if (process is null)
        {
            error = "无法启动 dsh：进程创建返回空。";
            Log("start failed: null process");
            return false;
        }

        _process = process;
        Log($"pid: {process.Id}");
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) =>
        {
            // 用局部 process 而不是字段：重试时字段已指向新进程，旧事件会读错退出码。
            if (!ReferenceEquals(_process, process)) return;
            try
            {
                _exitCode = process.ExitCode;
                Log($"process {process.Id} exited with code {_exitCode}");
            }
            catch (Exception ex)
            {
                Log("exit code unavailable: " + ex.Message);
            }
        };

        // 持续读取 stdout/stderr：既避免管道写满阻塞子进程，也从中解析 token 地址。
        _ = PumpAsync(process.StandardOutput, "out");
        _ = PumpAsync(process.StandardError, "err");
        return true;
    }

    /// <summary>
    /// 等待服务就绪：带 token 的地址出现并返回 2xx 即成功；子进程退出则立刻失败。
    /// </summary>
    /// <param name="timeout">最长等待时间。</param>
    /// <param name="onTick">周期性进度回调（约每 3 秒一次）。</param>
    /// <param name="cancellationToken">取消令牌。</param>
    /// <returns>就绪 / 已退出 / 超时。</returns>
    public async Task<ServerReadiness> WaitAsync(TimeSpan timeout, Func<TimeSpan, Task>? onTick = null, CancellationToken cancellationToken = default)
    {
        var watch = Stopwatch.StartNew();
        var nextTick = TimeSpan.FromSeconds(2);
        while (watch.Elapsed < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var process = _process;
            if (process is null)
            {
                Log("wait: no process");
                return ServerReadiness.Exited;
            }
            if (process.HasExited)
            {
                Log("wait: process exited before ready");
                return ServerReadiness.Exited;
            }

            var url = _authUrl;
            if (url != null && await ProbeAsync(url))
            {
                Log($"ready after {watch.Elapsed.TotalSeconds:0.0}s: {Origin}");
                return ServerReadiness.Ready;
            }

            if (onTick != null && watch.Elapsed >= nextTick)
            {
                nextTick += TimeSpan.FromSeconds(3);
                try { await onTick(watch.Elapsed); } catch { /* 进度提示失败不影响启动 */ }
            }
            await Task.Delay(400, cancellationToken);
        }
        Log($"wait: timed out after {timeout.TotalSeconds:0}s ({_probeNote})");
        return ServerReadiness.TimedOut;
    }

    /// <summary>把一次失败翻译成可读的原因（含子进程输出的关键行）。</summary>
    /// <param name="readiness">等待结果。</param>
    /// <param name="portFallback">本次是否因为端口冲突改用了自动端口。</param>
    /// <returns>给人看的失败说明。</returns>
    public string Explain(ServerReadiness readiness, bool portFallback = false)
    {
        var detail = FirstMeaningfulLine();
        var suffix = string.IsNullOrEmpty(detail) ? "" : " " + detail;
        var text = readiness switch
        {
            ServerReadiness.Exited =>
                $"dsh web 启动失败（退出码 {ExitCode?.ToString() ?? "未知"}）。{suffix}",
            ServerReadiness.TimedOut when !HasAuthUrl =>
                "等待 dsh web 输出访问地址超时：进程仍在运行，但一直没打印带 token 的地址。"
                + "刚开机时磁盘和 CPU 常被启动项占满，首次加载可能明显变慢。" + suffix,
            ServerReadiness.TimedOut =>
                $"dsh web 已输出访问地址，但探测没有通过（最近一次：{(_probeNote.Length == 0 ? "无响应" : _probeNote)}）。" + suffix,
            _ => "dsh web 未能就绪。" + suffix,
        };
        if (portFallback) text += "（已改用系统分配的端口重试）";
        else if (PortNote.Length != 0) text += "（" + PortNote + "）";
        return text;
    }

    /// <summary>进程是否仍在运行。</summary>
    public bool IsRunning => _process is { HasExited: false };

    /// <summary>是否已经拿到带 token 的地址。</summary>
    public bool HasAuthUrl => _authUrl != null;

    /// <summary>停止子进程（整棵进程树）。</summary>
    public void Stop()
    {
        try
        {
            if (_process is { HasExited: false })
            {
                Log("stopping process tree");
                _process.Kill(entireProcessTree: true);
                if (!_process.WaitForExit(3000)) Log("stop: 进程 3 秒内没有退出");
            }
        }
        catch (Exception ex)
        {
            Log("stop failed: " + ex.Message);
        }
        finally
        {
            _process = null;
            CloseLog();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
    }

    private void ResetState()
    {
        _authUrl = null;
        _origin = null;
        _probeNote = "";
        _exitCode = int.MinValue;
        PortNote = "";
        LastFailure = "";
        lock (_gate) _tail.Clear();
    }

    private async Task<bool> ProbeAsync(string url)
    {
        try
        {
            using var response = await Probe.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            _probeNote = $"HTTP {(int)response.StatusCode}";
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            _probeNote = ex.GetType().Name;
            return false;
        }
    }

    private async Task PumpAsync(StreamReader reader, string channel)
    {
        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                Log($"[{channel}] {line}");
                var match = TokenUrl.Match(line);
                if (match.Success) SetAuthUrl(match.Groups[1].Value);
            }
        }
        catch
        {
            // 子进程退出时管道关闭属正常情况
        }
    }

    private void SetAuthUrl(string url)
    {
        _authUrl = url;
        try
        {
            var origin = new Uri(url).GetLeftPart(UriPartial.Authority);
            _origin = origin;
        }
        catch
        {
            // 解析失败就保留 AuthUrl，由探测循环决定成败
        }
        Log($"auth url captured: {_authUrl}");
    }

    private void Log(string line)
    {
        lock (_gate)
        {
            _tail.Enqueue(line);
            while (_tail.Count > TailLines) _tail.Dequeue();
            try { _log?.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] {line}"); } catch { /* 日志失败不影响启动 */ }
        }
    }

    private string FirstMeaningfulLine()
    {
        string[] lines;
        lock (_gate) lines = _tail.ToArray();

        // 优先挑出真正的错误行，其次退回最后一行非空输出。
        foreach (var line in lines.Reverse())
        {
            if (line.Length == 0) continue;
            if (line.Contains("EADDRINUSE", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Error:", StringComparison.OrdinalIgnoreCase)
                || line.Contains("failed", StringComparison.OrdinalIgnoreCase)
                || line.Contains("not recognized", StringComparison.OrdinalIgnoreCase))
                return Compact(line);
        }
        return lines.Length == 0 ? "" : Compact(lines[^1]);
    }

    private static string Compact(string line)
    {
        var text = line.Replace("[err] ", "").Replace("[out] ", "").Trim();
        return text.Length <= 300 ? text : text[..300] + "…";
    }

    private void OpenLog()
    {
        try
        {
            // 默认写到 %LOCALAPPDATA%\DSH_Desktop\logs；DSH_DESKTOP_LOG_DIR 可改到别处（便于排查/测试）。
            var custom = Environment.GetEnvironmentVariable("DSH_DESKTOP_LOG_DIR");
            var dir = string.IsNullOrWhiteSpace(custom)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DSH_Desktop", "logs")
                : custom;
            Directory.CreateDirectory(dir);
            foreach (var old in new DirectoryInfo(dir).GetFiles("launch-*.log")
                         .OrderByDescending(file => file.LastWriteTime)
                         .Skip(KeptLogs - 1))
            {
                try { old.Delete(); } catch { /* 旧日志被占用就留着 */ }
            }
            LogPath = Path.Combine(dir, $"launch-{DateTime.Now:yyyyMMdd-HHmmss}.log");
            _log = new StreamWriter(LogPath, append: false, Encoding.UTF8) { AutoFlush = true };
        }
        catch
        {
            _log = null;
            LogPath = "";
        }
    }

    private void CloseLog()
    {
        try { _log?.Dispose(); } catch { }
        _log = null;
    }

    /// <summary>
    /// 定位 dsh：先看显式覆盖变量，再查常见 npm 全局目录（不启动子进程，最快最稳），
    /// 最后才回退到 `where dsh`。整个过程写进日志，失败时不再是「一句未安装」。
    /// </summary>
    private string? ResolveDsh()
    {
        var explicitPath = Environment.GetEnvironmentVariable("DSH_DESKTOP_DSH");
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            Log($"lookup: DSH_DESKTOP_DSH={explicitPath}");
            if (File.Exists(explicitPath)) return explicitPath;
            Log("lookup: DSH_DESKTOP_DSH 指向的文件不存在，继续自动查找");
        }

        foreach (var dir in ShimDirectories())
        {
            foreach (var name in ShimNames)
            {
                var candidate = Path.Combine(dir, name);
                if (!File.Exists(candidate)) continue;
                Log($"lookup: 命中 {candidate}");
                return candidate;
            }
            Log($"lookup: {dir} 下没有 {string.Join("/", ShimNames)}");
        }

        return FromWhere();
    }

    private static IEnumerable<string> ShimDirectories()
    {
        var dirs = new List<string>();
        void Add(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            if (!dirs.Contains(path, StringComparer.OrdinalIgnoreCase)) dirs.Add(path);
        }
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"));
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "npm"));
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        var x86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        if (!string.IsNullOrWhiteSpace(x86)) Add(Path.Combine(x86, "nodejs"));
        return dirs;
    }

    /// <summary>执行 `where dsh`，带超时且同时读空两个管道（否则子进程可能写满缓冲区卡住）。</summary>
    private string? FromWhere()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe",
                Arguments = "/d /c where dsh",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var process = Process.Start(psi);
            if (process is null)
            {
                Log("lookup: `where dsh` 无法创建进程");
                return null;
            }

            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit((int)WhereTimeout.TotalMilliseconds))
            {
                try { process.Kill(entireProcessTree: true); } catch { /* 已退出 */ }
                Log($"lookup: `where dsh` 超过 {WhereTimeout.TotalSeconds:0} 秒未返回");
                return null;
            }

            var output = stdout.GetAwaiter().GetResult();
            var errorText = stderr.GetAwaiter().GetResult().Trim();
            foreach (var raw in output.Split('\r', '\n'))
            {
                var candidate = raw.Trim();
                if (candidate.Length == 0) continue;
                if (!ShimNames.Any(name => candidate.EndsWith(name, StringComparison.OrdinalIgnoreCase))) continue;
                if (!File.Exists(candidate)) continue;
                Log($"lookup: PATH 命中 {candidate}");
                return candidate;
            }

            var firstErrorLine = errorText.Split('\n').Select(part => part.Trim()).FirstOrDefault(part => part.Length != 0);
            Log("lookup: `where dsh` 没有返回可用的 dsh.cmd/dsh.exe/dsh.bat"
                + (firstErrorLine is null ? "" : $"（{firstErrorLine}）"));
        }
        catch (Exception ex)
        {
            Log("lookup: `where dsh` 失败：" + ex.Message);
        }
        return null;
    }

    /// <summary>同步探测端口是否已有进程在监听（无监听时最多阻塞约 0.7 秒）。</summary>
    private static bool IsListening(int port)
    {
        try
        {
            using var client = new TcpClient();
            var connect = client.ConnectAsync("127.0.0.1", port);
            return connect.Wait(TimeSpan.FromMilliseconds(700)) && client.Connected;
        }
        catch
        {
            return false;
        }
    }

    private static string WorkspaceDirectory()
    {
        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        return Directory.Exists(documents) ? documents : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    private static string DshHome()
    {
        // 对话记录/数据根目录：优先使用环境变量 DSH_HOME（指向 D:\DSH\Memory），
        // 未设置时回退到用户主目录下的 .dsh。
        var custom = Environment.GetEnvironmentVariable("DSH_HOME");
        if (!string.IsNullOrWhiteSpace(custom)) return custom;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
    }
}
