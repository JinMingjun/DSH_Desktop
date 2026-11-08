using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace DSH_Desktop;

/// <summary>本地客户端插件资源与余额宿主桥。</summary>
public sealed class DesktopPlugins(CoreWebView2 webView, Uri origin) : IDisposable
{
    private static readonly HttpClient BalanceClient = new() { Timeout = TimeSpan.FromSeconds(10) };
    private readonly SemaphoreSlim _balanceGate = new(1, 1);
    private DateTimeOffset _balanceFetchedAt;
    private string? _cachedBalance;
    private bool _disposed;
    private int _navigation;
    private string? _scriptId;
    private readonly List<Stream> _responses = [];

    public async Task InitializeAsync()
    {
        var script = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "assets", "desktop-bootstrap.js"));
        _scriptId = await webView.AddScriptToExecuteOnDocumentCreatedAsync(script.Replace("__DSH_ORIGIN__", origin.GetLeftPart(UriPartial.Authority)));
        webView.AddWebResourceRequestedFilter(origin.GetLeftPart(UriPartial.Authority) + "/__desktop/plugins/*", CoreWebView2WebResourceContext.Script);
        webView.WebResourceRequested += OnResourceRequested;
        webView.WebMessageReceived += OnMessageReceived;
        webView.NavigationStarting += OnNavigationStarting;
        webView.NavigationCompleted += OnNavigationCompleted;
    }

    private bool IsLocal(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && uri.Scheme == origin.Scheme && uri.Host == origin.Host && uri.Port == origin.Port;

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e) => _navigation++;
    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        foreach (var stream in _responses) stream.Dispose();
        _responses.Clear();
    }

    private void OnResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (!IsLocal(e.Request.Uri)) return;
        var (plugin, id) = new Uri(e.Request.Uri).AbsolutePath switch
        {
            "/__desktop/plugins/wallpaper.js" => ("dsh-wallpaper", "dsh-desktop-wallpaper"),
            "/__desktop/plugins/stats-surface.js" => ("dsh-stats-surface", "dsh-desktop-stats-surface"),
            _ => (null, null),
        };
        if (plugin is null) return;
        try
        {
            var code = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "plugins", plugin, "lib", "client.js"))
                .Replace($"id: \"{plugin}\"", $"id: \"{id}\"");
            var stream = new MemoryStream(Encoding.UTF8.GetBytes(code));
            _responses.Add(stream);
            e.Response = webView.Environment.CreateWebResourceResponse(stream, 200, "OK", "Content-Type: application/javascript; charset=utf-8\r\nCache-Control: no-store");
        }
        catch (IOException)
        {
            e.Response = webView.Environment.CreateWebResourceResponse(null, 404, "Desktop plugin missing", "Cache-Control: no-store");
        }
    }

    private async void OnMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_disposed || !IsLocal(e.Source) || !IsLocal(webView.Source)) return;
        string? requestId;
        try
        {
            using var json = JsonDocument.Parse(e.WebMessageAsJson);
            var root = json.RootElement;
            if (root.GetProperty("type").GetString() != "dsh:balance-get") return;
            requestId = root.GetProperty("requestId").GetString();
            if (!Guid.TryParse(requestId, out _)) return;
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException) { return; }

        var navigation = _navigation;
        void Reply(object value)
        {
            if (!_disposed && navigation == _navigation && IsLocal(webView.Source))
                webView.PostWebMessageAsJson(JsonSerializer.Serialize(value));
        }

        var (balance, error) = await GetBalanceAsync();
        Reply(new { type = "dsh:balance-result", requestId, balance, error });
    }

    private async Task<(string? Balance, string? Error)> GetBalanceAsync()
    {
        var key = Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY");
        if (string.IsNullOrWhiteSpace(key)) return (null, "未设置 DEEPSEEK_API_KEY");
        await _balanceGate.WaitAsync();
        try
        {
            if (_cachedBalance is not null && DateTimeOffset.UtcNow - _balanceFetchedAt < TimeSpan.FromSeconds(5))
                return (_cachedBalance, null);
            using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.deepseek.com/user/balance");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var response = await BalanceClient.SendAsync(request);
            if (!response.IsSuccessStatusCode)
                return (null, response.StatusCode == System.Net.HttpStatusCode.Unauthorized ? "API 密钥无效" : $"余额接口返回 HTTP {(int)response.StatusCode}");
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var json = await JsonDocument.ParseAsync(stream);
            if (!json.RootElement.TryGetProperty("balance_infos", out var infos) || infos.ValueKind != JsonValueKind.Array)
                return (null, "余额接口返回的数据无效");
            foreach (var info in infos.EnumerateArray())
            {
                if (info.ValueKind != JsonValueKind.Object || !info.TryGetProperty("currency", out var currency) || currency.GetString() != "CNY") continue;
                if (!info.TryGetProperty("total_balance", out var total) || total.ValueKind != JsonValueKind.String) break;
                var value = total.GetString();
                if (value is null || !decimal.TryParse(value, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out _)) break;
                _cachedBalance = value;
                _balanceFetchedAt = DateTimeOffset.UtcNow;
                return (value, null);
            }
            return (null, "余额接口未提供有效的 CNY 余额");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or IOException)
        { return (null, "余额查询失败，请稍后重试"); }
        finally { _balanceGate.Release(); }
    }

    public void Dispose()
    {
        _disposed = true;
        webView.WebResourceRequested -= OnResourceRequested;
        webView.WebMessageReceived -= OnMessageReceived;
        webView.NavigationStarting -= OnNavigationStarting;
        webView.NavigationCompleted -= OnNavigationCompleted;
        if (_scriptId is not null) webView.RemoveScriptToExecuteOnDocumentCreated(_scriptId);
        foreach (var stream in _responses) stream.Dispose();
        _responses.Clear();
    }
}
