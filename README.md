# DSH Desktop（Windows）
DeepSeek. V4-flash自己做的客户端，我知道我做的其实已经有点晚了，但是还是把它放出来吧。
DeepSeek Harness 桌面客户端：后台运行 `dsh web`，使用 WPF + WebView2 显示独立窗口，并加载随程序分发的桌面插件。

## 从仓库部署

需要 Windows 10/11、WebView2 Runtime、Node.js/npm 和 .NET 8 SDK。本仓库已包含桌面端、背景、附件和余额插件的源码；`publish/` 是本地构建结果，不随 Git 上传。

```powershell
git clone https://github.com/JinMingjun/DSH_Desktop.git
cd DSH_Desktop
npm install -g @deepseek-ai/dsh@0.1.2-rc.1
$wallpaperPlugin = (Resolve-Path .\plugins\dsh-wallpaper).Path
dsh plugin --profile web add -w $wallpaperPlugin
dotnet publish DSH_Desktop.csproj -c Release -r win-x64 --self-contained true -o publish
.\publish\DSH_Desktop.exe
```

`0.1.2-rc.1` 是此项目验证过的 DSH 版本；升级后需要重新检查插件插槽兼容性。安装后应能在终端执行 `dsh.cmd`。`DSH_HOME` 可选，默认使用用户目录下的 `.dsh`；如需另存对话和配置，**在执行插件安装命令之前**设置指向可写目录的 `DSH_HOME`。这些本地数据无需复制进仓库。上面的 `dsh plugin` 命令把仓库中的壁纸 host 插件接到本机 DSH profile，以支持粘贴本地图片绝对路径；它写入的是本机 profile，换电脑后需重新运行。背景、附件和余额的客户端代码由桌面程序自动加载。

余额插件使用启动桌面程序时的 `DEEPSEEK_API_KEY` 用户环境变量。请先在 Windows 环境变量设置自己的 DeepSeek 官方 API 密钥，再重新打开终端或桌面程序。DSH 默认也使用这个变量。若只把密钥保存在 DSH 的凭据文件或模型设置中、没有设置该环境变量，余额会显示 `余额：-- CNY`；插件不会从该文件读取密钥，也不会把密钥传给网页。余额请求固定发送到 DeepSeek 官方 `GET https://api.deepseek.com/user/balance`，不适用于第三方兼容接口。

## 使用

启动 `publish/DSH_Desktop.exe`。更新源码后先关闭旧窗口、重新运行上面的 `dotnet publish`，再启动程序。发布目录中的 `assets` 和 `plugins` 文件夹必须与可执行文件一起保留。

- **背景个性化**：右上方的图片图标打开设置面板；单色图标、主题配色，按 Esc 收起。右侧插件栏从上往下排列。
- **附件**：输入框左下角的回形针打开 Windows 文件选择窗口，支持多选。文件卡片位于输入框上方，与输入框等宽，多行排列；点卡片的 × 移除。官方加号仍用于原来的指令菜单。
- **图片**：PNG、JPEG、WebP、GIF 通过 DSH 原生图片附件通道添加，受当前模型的图片限制约束。
- **其他文件**：通过 DSH 的 `@文件路径` 机制提交，支持中文、空格路径。卡片代替输入框中的重复引用显示。能否解析 PDF、Office、音视频等内容，取决于 DSH 及其工具能力；本插件不增加这些格式的解析器。
- **API 余额**：Session 日志下方、与“对话 / 轨迹”平齐处显示当前 DeepSeek API 账户的人民币可用余额，与按钮居中对齐，每 15 秒更新。由桌面宿主使用 `DEEPSEEK_API_KEY` 查询，密钥不进入网页脚本。
- **统计状态**：输入框下方的统计行使用随主题变化的毛玻璃底板，宽度与输入框一致；系统要求减少透明度或浏览器不支持背景模糊时显示实色底板。

桌面插件从发布目录直接加载，无需改写或重新安装到 DSH profile。现有背景设置继续使用 `dswp:*`；文件附件草稿元数据使用 WebView 本地存储 `dsa:draft:*`。对话历史仍由 DSH 管理。

## 构建与验证

- 发布命令含 .NET 运行时，目标环境仍需 WebView2 Runtime。
- 插件接口在 DSH `0.1.2-rc.1` 验证。

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
| `DesktopPlugins.cs` | 本地插件资源、原生文件窗口、余额查询宿主桥 |
| `assets/desktop-bootstrap.js` | 启动前合并桌面插件清单、文件与余额消息桥 |
| `plugins/dsh-wallpaper` | 右侧插件图标栏及壁纸设置 |
| `plugins/dsh-attachments` | 回形针、附件卡片、DSH 文件和图片接入 |
| `plugins/dsh-balance` | DeepSeek API 余额显示 |
| `plugins/dsh-stats-surface` | 输入框下方统计行的毛玻璃底板 |
| `tests/attachments.test.cjs` | 路径、草稿、去重、移除、图片限制和插件清单检查 |

## 后续插件的右侧入口

背景插件通过 `shell.overlay` 提供 `desktop.plugin.action` 列表插槽。后续插件将图标注册到该插槽，按 `order` 从上到下排列；无需再创建独立悬浮按钮。按钮应提供 `title` 和 `aria-label`，保持图标尺寸和交互风格一致。
