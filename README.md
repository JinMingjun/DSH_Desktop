# DSH Desktop（Windows）

DeepSeek Harness 桌面客户端：后台运行 `dsh web`，使用 WPF + WebView2 显示独立窗口，并加载随程序分发的桌面插件。

## 使用

启动 `publish/DSH_Desktop.exe`。更新时保留整个发布目录中的 `assets` 和 `plugins` 文件夹，关闭旧窗口后重新启动。

- **背景个性化**：右上方的图片图标打开设置面板；单色图标、主题配色，按 Esc 收起。右侧插件栏从上往下排列。
- **附件**：输入框左下角的回形针打开 Windows 文件选择窗口，支持多选。文件卡片位于输入框上方，与输入框等宽，多行排列；点卡片的 × 移除。官方加号仍用于原来的指令菜单。
- **图片**：PNG、JPEG、WebP、GIF 通过 DSH 原生图片附件通道添加，受当前模型的图片限制约束。
- **其他文件**：通过 DSH 的 `@文件路径` 机制提交，支持中文、空格路径。卡片代替输入框中的重复引用显示。能否解析 PDF、Office、音视频等内容，取决于 DSH 及其工具能力；本插件不增加这些格式的解析器。

桌面插件从发布目录直接加载，无需改写或重新安装到 DSH profile。现有背景设置继续使用 `dswp:*`；文件附件草稿元数据使用 WebView 本地存储 `dsa:draft:*`。对话历史仍由 DSH 管理。

## 环境与构建

- Windows 10/11、WebView2 Runtime。
- 通过 npm 全局安装的 `@deepseek-ai/dsh`，确保 `dsh.cmd` 可用。
- 编译需要 .NET 8 SDK；下方发布命令包含 .NET 运行时。
- 本次插件接口已在 DSH `0.1.2-rc.1` 验证；升级 DSH 后需要检查输入框插槽和草稿接口的兼容性。

```powershell
dotnet build -c Release
dotnet publish -c Release -r win-x64 --self-contained true -o publish
node --test tests/attachments.test.cjs
```

测试运行时可通过 `DSH_HOME` 指向独立数据目录、`WEBVIEW2_USER_DATA_FOLDER` 指向独立浏览器数据目录，避免使用真实会话数据。运行前应确保测试端口没有已有 DSH 服务，否则桌面程序会复用已有服务。

## 结构

| 路径 | 作用 |
| --- | --- |
| `MainWindow.xaml.cs` | 窗口初始化、服务启动、WebView 生命周期 |
| `ServerManager.cs` | 查找、启动和停止 `dsh web` |
| `DesktopPlugins.cs` | 本地插件资源、原生多选文件窗口、图片读取 |
| `assets/desktop-bootstrap.js` | 启动前合并桌面插件清单、文件选择消息桥 |
| `plugins/dsh-wallpaper` | 右侧插件图标栏及壁纸设置 |
| `plugins/dsh-attachments` | 回形针、附件卡片、DSH 文件和图片接入 |
| `tests/attachments.test.cjs` | 路径、草稿、去重、移除、图片限制和插件清单检查 |

## 后续插件的右侧入口

背景插件通过 `shell.overlay` 提供 `desktop.plugin.action` 列表插槽。后续插件将图标注册到该插槽，按 `order` 从上到下排列；无需再创建独立悬浮按钮。按钮应提供 `title` 和 `aria-label`，保持图标尺寸和交互风格一致。
