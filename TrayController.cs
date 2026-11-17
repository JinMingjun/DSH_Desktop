using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Forms = System.Windows.Forms;

namespace DSH_Desktop;

/// <summary>
/// Windows 托盘与 dsh-tray 浏览器插件之间的宿主桥。
/// 插件负责 DSH 会话语义；本类只负责原生窗口、菜单和进程退出。
/// </summary>
public sealed class TrayController : IDisposable
{
    private const int MaxRecentSessions = 5;

    private readonly Window _window;
    private readonly CoreWebView2 _webView;
    private readonly Uri _origin;
    private readonly Forms.NotifyIcon _notifyIcon;
    private readonly Forms.ContextMenuStrip _menu;
    private readonly Icon _icon;
    private IReadOnlyList<RecentSession> _recent = [];
    private WindowState _restoreState = WindowState.Normal;
    private bool _disposed;

    public event EventHandler? ExitRequested;

    /// <summary>由 dsh-tray 的浏览器半侧确认的实时开关状态。</summary>
    public bool Enabled { get; private set; }

    public TrayController(Window window, CoreWebView2 webView, Uri origin)
    {
        _window = window;
        _webView = webView;
        _origin = origin;

        var iconPath = Path.Combine(AppContext.BaseDirectory, "assets", "AppIcon.ico");
        _icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
        _menu = new Forms.ContextMenuStrip
        {
            BackColor = Color.FromArgb(32, 32, 32),
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 10F),
            ShowImageMargin = false,
            Renderer = new Forms.ToolStripProfessionalRenderer(new DarkMenuColors()),
        };
        _menu.Opening += OnMenuOpening;

        _notifyIcon = new Forms.NotifyIcon
        {
            Icon = _icon,
            Text = "DeepSeek Harness",
            ContextMenuStrip = _menu,
            Visible = false,
        };
        _notifyIcon.MouseClick += OnTrayMouseClick;
        _webView.WebMessageReceived += OnWebMessageReceived;
    }

    /// <summary>记住关闭前的窗口状态并隐藏主窗口。</summary>
    public void HideWindow()
    {
        if (_disposed || !Enabled) return;
        if (_window.WindowState != WindowState.Minimized)
            _restoreState = _window.WindowState;
        _window.Hide();
    }

    private void RestoreWindow()
    {
        if (_disposed) return;
        if (!_window.IsVisible) _window.Show();
        _window.WindowState = _restoreState == WindowState.Minimized ? WindowState.Normal : _restoreState;
        _window.Activate();
        _window.Topmost = true;
        _window.Topmost = false;
        _window.Focus();
    }

    private void OnTrayMouseClick(object? sender, Forms.MouseEventArgs e)
    {
        if (e.Button != Forms.MouseButtons.Left) return;
        _window.Dispatcher.Invoke(RestoreWindow);
    }

    private void OnMenuOpening(object? sender, CancelEventArgs e) => RebuildMenu();

    private void RebuildMenu()
    {
        while (_menu.Items.Count > 0)
        {
            var item = _menu.Items[0];
            _menu.Items.RemoveAt(0);
            item.Dispose();
        }

        _menu.Items.Add(new Forms.ToolStripMenuItem("最近的对话")
        {
            Enabled = false,
            ForeColor = Color.FromArgb(155, 181, 225),
        });

        if (_recent.Count == 0)
        {
            _menu.Items.Add(new Forms.ToolStripMenuItem("暂无对话") { Enabled = false });
        }
        else
        {
            foreach (var session in _recent.Take(MaxRecentSessions))
            {
                var item = new Forms.ToolStripMenuItem(TrimMenuText(session.Title, 56))
                {
                    ToolTipText = session.Workspace.Length == 0 ? session.Title : $"{session.Title}\n{session.Workspace}",
                    Tag = session.Id,
                };
                item.Click += (_, _) => SendCommand("open-session", session.Id);
                _menu.Items.Add(item);
            }
        }

        _menu.Items.Add(new Forms.ToolStripSeparator());
        var newChat = new Forms.ToolStripMenuItem("新建对话");
        newChat.Click += (_, _) => SendCommand("new-chat");
        _menu.Items.Add(newChat);
        _menu.Items.Add(new Forms.ToolStripSeparator());
        var exit = new Forms.ToolStripMenuItem("退出");
        exit.Click += (_, _) => _window.Dispatcher.Invoke(() => ExitRequested?.Invoke(this, EventArgs.Empty));
        _menu.Items.Add(exit);
    }

    private void SendCommand(string command, string? sessionId = null)
    {
        _window.Dispatcher.Invoke(() =>
        {
            RestoreWindow();
            if (_disposed || !Enabled) return;
            _webView.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "dsh:tray-command",
                command,
                sessionId,
            }));
        });
    }

    private bool IsLocal(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && uri.Scheme == _origin.Scheme && uri.Host == _origin.Host && uri.Port == _origin.Port;

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_disposed || !IsLocal(e.Source) || !IsLocal(_webView.Source)) return;
        try
        {
            using var json = JsonDocument.Parse(e.WebMessageAsJson);
            var root = json.RootElement;
            if (!root.TryGetProperty("type", out var type)) return;

            switch (type.GetString())
            {
                case "dsh:tray-state":
                    if (root.TryGetProperty("enabled", out var enabled)
                        && enabled.ValueKind is JsonValueKind.True or JsonValueKind.False)
                        SetEnabled(enabled.GetBoolean());
                    break;
                case "dsh:tray-recent":
                    if (root.TryGetProperty("sessions", out var sessions) && sessions.ValueKind == JsonValueKind.Array)
                        _recent = ParseRecent(sessions);
                    break;
            }
        }
        catch (JsonException)
        {
            // 忽略非本插件消息或格式不完整的页面消息。
        }
    }

    private void SetEnabled(bool enabled)
    {
        if (_disposed || Enabled == enabled) return;
        Enabled = enabled;
        _notifyIcon.Visible = enabled;
        if (!enabled)
        {
            _recent = [];
            if (!_window.IsVisible) RestoreWindow();
        }
    }

    private static IReadOnlyList<RecentSession> ParseRecent(JsonElement sessions)
    {
        var result = new List<RecentSession>(MaxRecentSessions);
        foreach (var entry in sessions.EnumerateArray())
        {
            if (result.Count >= MaxRecentSessions || entry.ValueKind != JsonValueKind.Object) break;
            if (!entry.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String) continue;
            if (!entry.TryGetProperty("title", out var title) || title.ValueKind != JsonValueKind.String) continue;
            var idValue = id.GetString();
            var titleValue = title.GetString();
            if (string.IsNullOrWhiteSpace(idValue) || string.IsNullOrWhiteSpace(titleValue)) continue;
            var workspace = entry.TryGetProperty("workspace", out var workspaceElement)
                && workspaceElement.ValueKind == JsonValueKind.String
                ? workspaceElement.GetString() ?? ""
                : "";
            result.Add(new RecentSession(idValue, titleValue, workspace));
        }
        return result;
    }

    private static string TrimMenuText(string value, int max)
    {
        var text = value.Replace('&', '＆').Replace('\r', ' ').Replace('\n', ' ').Trim();
        return text.Length <= max ? text : text[..(max - 1)] + "…";
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Enabled = false;
        _webView.WebMessageReceived -= OnWebMessageReceived;
        _notifyIcon.Visible = false;
        _notifyIcon.MouseClick -= OnTrayMouseClick;
        _menu.Opening -= OnMenuOpening;
        _notifyIcon.Dispose();
        _menu.Dispose();
        if (!ReferenceEquals(_icon, SystemIcons.Application)) _icon.Dispose();
    }

    private sealed record RecentSession(string Id, string Title, string Workspace);

    private sealed class DarkMenuColors : Forms.ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => Color.FromArgb(32, 32, 32);
        public override Color ImageMarginGradientBegin => Color.FromArgb(32, 32, 32);
        public override Color ImageMarginGradientMiddle => Color.FromArgb(32, 32, 32);
        public override Color ImageMarginGradientEnd => Color.FromArgb(32, 32, 32);
        public override Color MenuItemSelected => Color.FromArgb(55, 55, 58);
        public override Color MenuItemBorder => Color.FromArgb(75, 75, 78);
        public override Color SeparatorDark => Color.FromArgb(80, 80, 82);
        public override Color SeparatorLight => Color.FromArgb(80, 80, 82);
    }
}
