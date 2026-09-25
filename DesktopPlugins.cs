using System.IO;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace DSH_Desktop;

/// <summary>Local client bundles and a narrowly scoped native file picker.</summary>
public sealed class DesktopPlugins(Window owner, CoreWebView2 webView, Uri origin) : IDisposable
{
    private const long MaxImageBytes = 20 * 1024 * 1024;
    private const long MaxBatchImageBytes = 64 * 1024 * 1024;
    private const int MaxFiles = 32;
    private bool _picking;
    private static readonly HttpClient BalanceClient = new() { Timeout = TimeSpan.FromSeconds(10) };
    private readonly SemaphoreSlim _balanceGate = new(1, 1);
    private DateTimeOffset _balanceFetchedAt;
    private string? _cachedBalance;
    private bool _disposed;
    private int _navigation;
    private string? _scriptId;
    private readonly List<Stream> _responses = [];
    private static readonly Dictionary<string, string> ImageTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp", [".gif"] = "image/gif",
    };

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
            "/__desktop/plugins/attachments.js" => ("dsh-attachments", "dsh-desktop-attachments"),
            "/__desktop/plugins/balance.js" => ("dsh-balance", "dsh-desktop-balance"),
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
        string? type;
        try
        {
            using var json = JsonDocument.Parse(e.WebMessageAsJson);
            var root = json.RootElement;
            type = root.GetProperty("type").GetString();
            if (type is not ("dsh:pick-files" or "dsh:balance-get")) return;
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
        if (type == "dsh:balance-get")
        {
            var (balance, error) = await GetBalanceAsync();
            Reply(new { type = "dsh:balance-result", requestId, balance, error });
            return;
        }
        if (_picking)
        {
            Reply(new { type = "dsh:files-picked", requestId, error = "文件选择窗口已打开" });
            return;
        }
        _picking = true;
        try
        {
            // Leave the WebView callback before showing a modal UI (WebView2 reentrancy).
            await owner.Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.Background);
            if (_disposed || navigation != _navigation) return;
            var picker = new OpenFileDialog
            {
                Title = "添加附件", Multiselect = true, CheckFileExists = true, CheckPathExists = true,
                Filter = "所有文件 (*.*)|*.*|图片 (*.png;*.jpg;*.jpeg;*.webp;*.gif)|*.png;*.jpg;*.jpeg;*.webp;*.gif|文档 (*.pdf;*.docx;*.xlsx;*.pptx;*.txt;*.md;*.csv)|*.pdf;*.docx;*.xlsx;*.pptx;*.txt;*.md;*.csv",
            };
            if (picker.ShowDialog(owner) != true)
            {
                Reply(new { type = "dsh:files-picked", requestId, cancelled = true, files = Array.Empty<object>() });
                return;
            }
            var paths = picker.FileNames.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (paths.Length > MaxFiles) throw new InvalidOperationException($"一次最多选择 {MaxFiles} 个文件，请减少后重试。");
            var files = new List<object>();
            var errors = new List<string>();
            long totalImages = 0;
            foreach (var path in paths)
            {
                try
                {
                    var info = new FileInfo(path);
                    var size = info.Length;
                    string? data = null;
                    string? mediaType = null;
                    if (ImageTypes.TryGetValue(info.Extension, out mediaType))
                    {
                        if (size == 0 || size > MaxImageBytes || totalImages + size > MaxBatchImageBytes)
                            throw new IOException("图片为空或超出限制（单张 20 MB，每批 64 MB）");
                        // Bound the read even if the selected file grows while it is opened.
                        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, true);
                        if (input.Length == 0 || input.Length > MaxImageBytes || totalImages + input.Length > MaxBatchImageBytes)
                            throw new IOException("图片为空或超出限制（单张 20 MB，每批 64 MB）");
                        var bytes = new byte[checked((int)input.Length)];
                        await input.ReadExactlyAsync(bytes);
                        totalImages += bytes.Length;
                        data = Convert.ToBase64String(bytes);
                        size = bytes.Length;
                    }
                    files.Add(new { path = info.FullName, name = info.Name, size, mediaType, data });
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                { errors.Add($"{Path.GetFileName(path)}：{ex.Message}"); }
            }
            Reply(new { type = "dsh:files-picked", requestId, cancelled = false, files, errors });
        }
        catch (Exception ex)
        { Reply(new { type = "dsh:files-picked", requestId, error = ex.Message }); }
        finally { _picking = false; }
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
