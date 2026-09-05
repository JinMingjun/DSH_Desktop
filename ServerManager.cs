using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;

namespace DSH_Desktop;

/// <summary>
/// 管理 `dsh web` 服务生命周期：探测是否已运行、拉起、退出时停止。
/// 对应 macOS 版的 DSHServer。dsh 通过 npm 全局安装（Windows 上是 dsh.cmd 垫片）。
/// </summary>
public sealed class ServerManager
{
    private Process? _process;

    public async Task<bool> IsRunningAsync(string url)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
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
        return _process != null;
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
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
    }
}
