using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace DSH_Desktop;

/// <summary>
/// 管理 `dsh web` 服务生命周期：探测是否已运行、拉起、退出时停止。
/// 对应 macOS 版的 DSHServer。dsh 通过 npm 全局安装（Windows 上是 dsh.cmd 垫片）。
/// </summary>
public sealed class ServerManager
{
    private Process? _process;
    private string? _token;
    private string? _authUrl;

    /// <summary>带 token 的完整访问地址（dsh web 需要 token 认证，token 来自启动时 stdout 打印的 URL）。</summary>
    public string? AuthUrl => _authUrl;

    /// <summary>探测服务是否在监听：只要收到 HTTP 响应（含 401 未认证）就视为“已启动”。</summary>
    public async Task<bool> IsRunningAsync(string url)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            return true; // 有 HTTP 响应 = 服务在运行
        }
        catch
        {
            return false;
        }
    }

    /// <summary>服务是否就绪：已从 stdout 捕获到 token，且带 token 访问返回 2xx。</summary>
    public async Task<bool> IsReadyAsync()
    {
        if (string.IsNullOrEmpty(_authUrl)) return false;
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var resp = await client.GetAsync(_authUrl, HttpCompletionOption.ResponseHeadersRead);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>拉起到指定端口；成功返回 true（并记住进程句柄以便停止）。</summary>
    public bool Start(int port)
    {
        string? dsh = FindDsh();
        if (dsh == null) return false;

        var psi = new ProcessStartInfo
        {
            // 用 cmd 跑 npm 生成的 dsh.cmd 垫片
            FileName = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe",
            Arguments = $"/c \"\"{dsh}\" web --no-open --port {port}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = WorkspaceDirectory(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["DSH_HOME"] = DshHome();

        try
        {
            _process = Process.Start(psi);
        }
        catch
        {
            return false;
        }
        if (_process == null) return false;

        // 后台持续读取 stdout/stderr：既防止子进程输出缓冲区写满阻塞，
        // 也从中解析 dsh web 启动时打印的带 token 访问地址。
        _ = PumpAsync(_process.StandardOutput, port, isError: false);
        _ = PumpAsync(_process.StandardError, port, isError: true);
        return true;
    }

    /// <summary>持续读取子进程输出，捕获形如 .../?token=xxx 的地址作为鉴权入口。</summary>
    private async Task PumpAsync(StreamReader reader, int port, bool isError)
    {
        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                var m = Regex.Match(line, @"\?token=([^\s&]+)");
                if (m.Success)
                {
                    _token = m.Groups[1].Value;
                    _authUrl = $"http://127.0.0.1:{port}/?token={_token}";
                }
                // 非 token 行直接丢弃（stderr 也不外显，保持安静）
            }
        }
        catch { }
    }

    public void Stop()
    {
        try
        {
            if (_process is { HasExited: false })
                _process.Kill(entireProcessTree: true);
        }
        catch { }
        _process = null;
    }

    /// <summary>定位 dsh（优先 `where dsh`，再回退到 npm 全局目录）。</summary>
    private static string? FindDsh()
    {
        // 1) where dsh
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe",
                Arguments = "/c where dsh",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            using var p = Process.Start(psi);
            if (p != null)
            {
                var output = p.StandardOutput.ReadToEnd();
                p.WaitForExit();
                foreach (var raw in output.Split('\r', '\n'))
                {
                    var t = raw.Trim();
                    if (t.Length == 0) continue;
                    if (t.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) ||
                        t.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
                        t.EndsWith(".ps1", StringComparison.OrdinalIgnoreCase) ||
                        t.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
                        return t;
                }
            }
        }
        catch { }

        // 2) 常见 npm/node 全局目录
        var dirs = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"),
        };
        foreach (var dir in dirs)
        {
            foreach (var name in new[] { "dsh.cmd", "dsh.exe", "dsh.ps1", "dsh.bat" })
            {
                var f = Path.Combine(dir, name);
                if (File.Exists(f)) return f;
            }
        }
        return null;
    }

    private static string WorkspaceDirectory()
    {
        var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        return Directory.Exists(docs) ? docs : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
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
