using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace DSH_Desktop;

/// <summary>
/// 主窗口：WebView2 承载 DeepSeek Harness Web UI。
/// 启动流程与 macOS 版一致：占位 Splash → 探测/拉起 `dsh web` → 就绪后淡出并加载 UI。
/// </summary>
public partial class MainWindow : Window
{
    private const int Port = 3080;
    private string Url => $"http://127.0.0.1:{Port}";

    private readonly ServerManager _server = new();
    private bool _serverSpawned = false;   // 仅当本应用自己拉起服务时才在退出时杀掉它

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await OnLoadedAsync();
    }

    private async Task OnLoadedAsync()
    {
        try
        {
            await InitializeWebViewAsync();
            await ShowSplashAsync();
            await StartAndLoadAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show("DeepSeek DSH 启动失败：" + ex.Message, "DeepSeek DSH", MessageBoxButton.OK, MessageBoxImage.Error);
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
        var html = File.Exists(path) ? await File.ReadAllTextAsync(path) : "<h2>DeepSeek Harness 启动中…</h2>";
        WebView.NavigateToString(html);
    }

    private async Task StartAndLoadAsync()
    {
        // dsh web 启动时需要 token 认证。若本应用尚未捕获到token（即服务还未由本应用拉起），
        // 则先拉起 dsh web，并从其 stdout 打印的地址中解析 token。
        if (string.IsNullOrEmpty(_server.AuthUrl))
        {
            _serverSpawned = _server.Start(Port);
        }

        // 等待服务就绪（最多 ~30s）
        bool up = false;
        for (int i = 0; i < 60; i++)
        {
            await Task.Delay(500);
            if (await _server.IsReadyAsync()) { up = true; break; }
        }

        if (!up)
        {
            await ShowSplashErrorAsync("DeepSeek Harness 服务未能启动。<br>请确认已通过 npm 全局安装 dsh，并在 PATH 中可访问。");
            return;
        }

        // Splash 淡出 → 加载带 token 的真实 UI
        try { await WebView.ExecuteScriptAsync("document.getElementById('splash').style.opacity='0'"); } catch { /* ignore */ }
        await Task.Delay(250);
        WebView.CoreWebView2.Navigate(_server.AuthUrl!);
    }

    private async Task ShowSplashErrorAsync(string message)
    {
        var escaped = message.Replace("\\", "\\\\").Replace("\"", "\\\"");
        var html = $"<html><body style=\"margin:0;height:100vh;background:#101014;display:flex;align-items:center;justify-content:center;" +
                   $"font-family:'Segoe UI',sans-serif;color:#e5484d;font-size:14px;padding:0 40px;text-align:center\">{escaped}</body></html>";
        WebView.NavigateToString(html);
        await Task.CompletedTask;
    }

    protected override void OnClosed(EventArgs e)
    {
        if (_serverSpawned) _server.Stop();
        base.OnClosed(e);
    }
}
