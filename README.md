# DSH_Desktop（Windows 版）

DeepSeek Harness 桌面壳 + 背景个性化插件，**macOS 版的原样 Windows 迁移**。
思路与 macOS 版完全一致：**后台运行 `dsh web` + 前台 WebView2 独立渲染**。

- 外壳：C# / WPF + WebView2（对应 macOS 的 Swift + WKWebView）
- 背景插件：`dsh-wallpaper`（纯 Web 代码，跨平台，直接复用）

## 目录结构

```
DSH_Desktop/
├── DSH_Desktop.csproj        # WPF 项目（.NET 8 + WebView2）
├── App.xaml / App.xaml.cs
├── MainWindow.xaml           # 窗口 + WebView2 控件
├── MainWindow.xaml.cs        # 启动流程：Splash → 拉起 dsh web → 淡出加载 UI
├── ServerManager.cs          # dsh web 生命周期（探测/拉起/停止）
├── assets/
│   ├── AppIcon.ico           # DeepSeek 鲸鱼图标（多尺寸）
│   └── Splash.html           # 启动过渡页（鲸鱼 logo + spinner + 淡入淡出）
└── plugins/
    └── dsh-wallpaper/        # 背景个性化插件（复用 macOS 版，无需改动）
```

## 前置条件

1. **Windows 10/11**，已安装 **.NET 8 SDK**（`dotnet --version` 验证）。
2. **WebView2 Runtime**（Win11 自带；Win10 通常随 Edge 安装，缺失时从
   Microsoft 官网下载 Evergreen Bootstrapper）。
3. **dsh 已通过 npm 全局安装**：`npm install -g @deepseek-ai/dsh`（装好后
   `where dsh` 能查到 `dsh.cmd`）。

## 构建 & 运行

```powershell
cd DSH_Desktop
dotnet build -c Release
dotnet run
```

打包发布单文件 exe（可选）：

```powershell
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true
```

> 若 `dotnet build` 报 WebView2 包版本不存在，执行
> `dotnet add package Microsoft.Web.WebView2` 更新到最新版即可。

## 安装背景插件

外壳启动后会自动拉起 `dsh web`（若已在运行则复用）。背景插件装进 DSH 的 web
profile（与 macOS 版命令一致）：

```powershell
dsh plugin --profile web add -w "<本项目绝对路径>\plugins\dsh-wallpaper"
```

装完**重启 `dsh web`**（退出外壳、`pkill` 或任务管理器结束 node 进程、重新打开
外壳即可）。此后修改插件 `lib/client.js` 只需刷新页面（bundle 按请求实时读取）。

## 与 macOS 版的对应关系

| macOS | Windows |
| --- | --- |
| WKWebView | WebView2 |
| Swift `runOpenPanelWithParameters` 弹文件面板 | WebView2 原生支持 `<input type=file>`（无需额外处理） |
| 需要手动加 Edit 菜单（Cmd+C/V） | WebView2 原生支持 Ctrl+C/V（无需额外处理） |
| `.icns` 图标 | `.ico` 图标（多尺寸） |
| `codesign` 签名 | 无需签名 |

启动过渡动画：`assets/Splash.html`（鲸鱼 logo + spinner + 淡入），就绪后 JS 把
`#splash` 透明度设为 0 再导航，`DefaultBackgroundColor` 设深色避免白闪 —— 与
macOS 版视觉效果一致。
