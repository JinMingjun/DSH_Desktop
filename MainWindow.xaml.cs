using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace DSH_Desktop;

/// <summary>
/// 主窗口：WebView2 承载 DeepSeek Harness Web UI。
/// 启动流程：先在后台线程拉起 `dsh web`（冷启动最耗时），同时初始化 WebView2 并显示 Splash，
/// 然后等待带 token 的地址；失败时给出可解释的原因与日志路径。
/// </summary>
public partial class MainWindow : Window
{
    /// <summary>首选端口；被占用时由 ServerManager 直接改用系统分配的空闲端口。</summary>
    private const int PreferredPort = 3080;

    /// <summary>
    /// 首次等待预算。0.2.x 的 dsh 要加载完 profile 与全部插件才打印地址，
    /// 刚开机时磁盘/CPU 被启动项占满，旧版的 30 秒会稳定超时（表现为「dsh 未安装」）。
    /// 可用环境变量 DSH_DESKTOP_READY_TIMEOUT（秒）覆盖。
    /// </summary>
    private static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(EnvSeconds("DSH_DESKTOP_READY_TIMEOUT", 180));

    /// <summary>进程提前退出后自动重试一次的等待预算（DSH_DESKTOP_RETRY_TIMEOUT）。</summary>
    private static readonly TimeSpan RetryTimeout = TimeSpan.FromSeconds(EnvSeconds("DSH_DESKTOP_RETRY_TIMEOUT", 180));

    private readonly ServerManager _server = new();
    private readonly CancellationTokenSource _lifetime = new();
    private DesktopPlugins? _desktopPlugins;
    private bool _serverSpawned;   // 仅当本应用自己拉起服务时才在退出时杀掉它
    private volatile bool _closing;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await OnLoadedAsync();
    }

    private static int EnvSeconds(string name, int fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (int.TryParse(raw, out var seconds) && seconds >= 5 && seconds <= 3600) return seconds;
        return fallback;
    }

    private async Task OnLoadedAsync()
    {
        try
        {
            // 先在后台线程拉起 dsh（它有 where/进程创建等阻塞调用，不能占 UI 线程），
            // 同时初始化 WebView2。WebView2 必须先就绪，否则出错时连提示页都显示不了。
            var startTask = Task.Run(() =>
            {
                var ok = _server.Start(PreferredPort, out var error);
                return (Started: ok, Error: error);
            });

            await InitializeWebViewAsync();
            await ShowSplashAsync();

            var start = await startTask;
            _serverSpawned = start.Started;
            if (_closing)
            {
                // 关闭窗口时后台启动可能刚好完成：把这次拉起的进程收掉，别留孤儿。
                if (_serverSpawned) _server.Stop();
                return;
            }

            if (!start.Started)
            {
                await ShowStartupErrorAsync(start.Error, TailForDisplay());
                return;
            }

            if (!await BringServerUpAsync())
            {
                if (_closing) return;
                await ShowStartupErrorAsync(_server.LastFailure, TailForDisplay());
                return;
            }

            if (_closing) return;

            // 桌面插件的同源判定要用服务实际监听的地址（可能是自动端口）。
            var origin = _server.Origin;
            if (origin == null || _server.AuthUrl == null)
            {
                _server.LastFailure = "dsh web 没有给出可用的访问地址。";
                await ShowStartupErrorAsync(_server.LastFailure, TailForDisplay());
                return;
            }
            _desktopPlugins = new DesktopPlugins(WebView.CoreWebView2, new Uri(origin));
            await _desktopPlugins.InitializeAsync();

            // Splash 淡出 → 加载带 token 的真实 UI
            try { await WebView.ExecuteScriptAsync("document.getElementById('splash').style.opacity='0'"); } catch { /* ignore */ }
            await Task.Delay(250);
            if (_closing) return;
            WebView.CoreWebView2.Navigate(_server.AuthUrl);
        }
        catch (OperationCanceledException) when (_closing)
        {
            // 用户在启动过程中关掉了窗口，属正常退出。
        }
        catch (Exception ex)
        {
            if (_closing) return;
            MessageBox.Show("DeepSeek Harness 启动失败：" + ex.Message, "DeepSeek Harness", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    /// <summary>
    /// 等待服务就绪。进程提前退出时说明原因并自动重试一次（端口冲突则改用自动端口）；
    /// 超时但进程还活着时**不杀进程**——刚开机时很可能只是加载慢，杀掉它只会让下一次也慢。
    /// </summary>
    /// <returns>是否已经拿到可用的、带 token 的地址。</returns>
    private async Task<bool> BringServerUpAsync()
    {
        for (var attempt = 0; ; attempt++)
        {
            var timeout = attempt == 0 ? ReadyTimeout : RetryTimeout;
            var readiness = await _server.WaitAsync(timeout, null, _lifetime.Token);
            if (readiness == ServerReadiness.Ready) return true;
            if (_closing) return false;

            if (readiness == ServerReadiness.TimedOut)
            {
                // 进程仍在运行：保留它，只报告超时（日志里有完整输出，便于下次判断）。
                _server.LastFailure = _server.Explain(readiness);
                return false;
            }

            // 进程提前退出：记录原因，重试一次。
            if (attempt >= 1)
            {
                _server.LastFailure = _server.Explain(readiness);
                return false;
            }

            var portConflict = _server.OutputTail.Contains("EADDRINUSE", StringComparison.OrdinalIgnoreCase);
            _server.Stop();
            await SetSplashStatusAsync(portConflict
                ? "端口被占用，正在改用自动端口重试…"
                : "第一次启动未成功，正在自动重试…");
            try { await Task.Delay(600, _lifetime.Token); }
            catch (OperationCanceledException) { return false; }

            var port = portConflict ? 0 : PreferredPort;
            var retryError = "";
            _serverSpawned = await Task.Run(() =>
            {
                var ok = _server.Start(port, out var error);
                retryError = error;
                return ok;
            });
            if (_closing)
            {
                if (_serverSpawned) _server.Stop();
                return false;
            }
            if (!_serverSpawned)
            {
                _server.LastFailure = "重试时无法再次启动 dsh：" + retryError;
                return false;
            }
        }
    }

    private async Task InitializeWebViewAsync()
    {
        await WebView.EnsureCoreWebView2Async();
        // 深色底，避免导航瞬间白屏闪烁
        WebView.DefaultBackgroundColor = Color.FromArgb(0xFF, 0x10, 0x10, 0x14);
    }

    private async Task ShowSplashAsync()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "assets", "Splash.html");
        var html = File.Exists(path) ? await File.ReadAllTextAsync(path) : "<html><body style=\"background:#101014\"></body></html>";
        WebView.NavigateToString(html);
    }

    /// <summary>把任意文本安全地写进 Splash 的 #status（页面已切走时静默忽略）。</summary>
    private async Task SetSplashStatusAsync(string text)
    {
        if (_closing) return;
        try
        {
            var script = "var el=document.getElementById('status');if(el){el.textContent="
                         + JsonSerializer.Serialize(text) + ";}";
            await WebView.ExecuteScriptAsync(script);
        }
        catch
        {
            // Splash 可能已切走或窗口正在关闭
        }
    }

    private string TailForDisplay()
    {
        var lines = _server.OutputTail
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .TakeLast(12);
        return string.Join(Environment.NewLine, lines);
    }

    private async Task ShowStartupErrorAsync(string message, string? detail)
    {
        if (_closing) return;
        if (string.IsNullOrWhiteSpace(message)) message = "dsh web 未能就绪，请查看下方日志末尾的输出了解原因。";
        var logPath = string.IsNullOrEmpty(_server.LogPath) ? "（日志目录不可写）" : _server.LogPath;

        var builder = new StringBuilder();
        builder.Append("<html><body style=\"margin:0;min-height:100vh;box-sizing:border-box;background:#101014;display:flex;")
            .Append("align-items:center;justify-content:center;font-family:'Segoe UI',sans-serif;color:#e5484d;")
            .Append("font-size:14px;padding:32px 40px;text-align:center\">")
            .Append("<div style=\"max-width:760px\">")
            .Append("<div style=\"line-height:1.7\">").Append(WebUtility.HtmlEncode(message)).Append("</div>");

        if (!string.IsNullOrWhiteSpace(detail))
        {
            builder.Append("<pre style=\"margin:16px 0 0;padding:12px 14px;max-height:260px;overflow:auto;text-align:left;")
                .Append("background:#1a1a20;border-radius:8px;color:#8b8f98;font-size:12px;line-height:1.5;white-space:pre-wrap\">")
                .Append(WebUtility.HtmlEncode(detail)).Append("</pre>");
        }

        builder.Append("<div style=\"margin-top:16px;color:#6f7480;font-size:12px;line-height:1.7\">")
            .Append("启动日志：").Append(WebUtility.HtmlEncode(logPath))
            .Append("<br>关闭窗口后重新打开即可重试；刚开机时首次启动可能较慢，稍等再开一次通常就能进入。</div>")
            .Append("</div></body></html>");

        try
        {
            WebView.NavigateToString(builder.ToString());
        }
        catch (Exception)
        {
            // WebView2 不可用时退回系统消息框，至少让原因可见。
            MessageBox.Show(message + (string.IsNullOrWhiteSpace(detail) ? "" : Environment.NewLine + Environment.NewLine + detail),
                "DeepSeek Harness", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        await Task.CompletedTask;
    }

    protected override void OnClosed(EventArgs e)
    {
        _closing = true;
        try { _lifetime.Cancel(); } catch { /* 已释放 */ }
        _desktopPlugins?.Dispose();
        if (_serverSpawned) _server.Stop();
        _server.Dispose();
        base.OnClosed(e);
    }
}
