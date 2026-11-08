# DSH Desktop（Windows）
这是一个面向 DeepSeek V4-Flash 的第三方桌面客户端。虽然发布得不算早，还是把它完整开源出来，方便需要独立窗口与个性化插件的人使用。

DeepSeek Harness 桌面客户端：后台运行 `dsh web`，使用 WPF + WebView2 显示独立窗口，并加载随程序分发的桌面插件。

## 从仓库部署

需要 Windows 10/11、WebView2 Runtime、Node.js/npm 和 .NET 8 SDK。本仓库已包含桌面端、背景、余额与两个可选人格预设插件的源码；`publish/` 是本地构建结果，不随 Git 上传。

```powershell
git clone https://github.com/JinMingjun/DSH_Desktop.git
cd DSH_Desktop
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
$wallpaperPlugin = (Resolve-Path .\plugins\dsh-wallpaper).Path
$balancePlugin = (Resolve-Path .\plugins\dsh-balance).Path
dsh plugin --profile web add -w $wallpaperPlugin
dsh plugin --profile web add -w $balancePlugin
dotnet publish DSH_Desktop.csproj -c Release -r win-x64 --self-contained true -o publish
.\publish\DSH_Desktop.exe
```

`0.2.1-rc.2` 是此项目验证过的 DSH 版本；升级后需要重新检查插件插槽兼容性与客户端启动图格式。安装后应能在终端执行 `dsh.cmd`。`DSH_HOME` 可选，默认使用用户目录下的 `.dsh`；如需另存对话和配置，**在执行插件安装命令之前**设置指向可写目录的 `DSH_HOME`。这些本地数据无需复制进仓库。上面的两条 `dsh plugin` 命令把仓库中的壁纸与余额插件接到本机 DSH profile（它们会写进 profile 的 `dependencies` 与 `dsh.profile.bundles`，换电脑后需重新运行）；统计底板的客户端代码仍由桌面程序自动加载。

两个“大肥鱼”人格预设是可选插件，不影响桌面端主体。需要时执行：

```powershell
$strongPreset = (Resolve-Path .\plugins\dsh-preset-dafeiyu-strong).Path
$weakPreset = (Resolve-Path .\plugins\dsh-preset-dafeiyu-weak).Path
dsh plugin --profile web add -w $strongPreset
dsh plugin --profile web add -w $weakPreset
```

安装后重启桌面端，即可在 Agent 预设中选择“`大肥鱼-强攻击性`”或“`大肥鱼-弱攻击性`”。两个预设都允许读文件、读图片与网页搜索，不开放文件写入或编辑能力；具体人格提示词保存在各自的 `cordis.patch.yml` 中。

余额插件是「宿主半侧 + 浏览器半侧」的 profile 插件：宿主侧用 DSH 里配置的 API Key
（`$DSH_HOME/.credentials.yaml` 的 `DEEPSEEK_API_KEY`，来自「设置 → 模型」）查询官方
`GET https://api.deepseek.com/user/balance`，读不到时回退到启动环境变量 `DEEPSEEK_API_KEY`；
浏览器只拿结果、从不接触密钥。两者都没有时余额显示 `余额：--`，悬停可看原因。


## 使用

启动 `publish/DSH_Desktop.exe`。更新源码后先关闭旧窗口、重新运行上面的 `dotnet publish`，再启动程序。发布目录中的 `assets` 和 `plugins` 文件夹必须与可执行文件一起保留。

- **背景个性化**：右上方的图片图标打开设置面板；单色图标、主题配色，按 Esc 收起。右侧插件栏从上往下排列。
- **附件**：输入框左下角的 `+` 菜单里是 DSH 0.2.x 自带的官方附件功能，文件与图片都按 DSH 自身能力处理；桌面端不再注入自定义回形针，也不再维护自己的文件选择桥。
- **API 余额**：Session 日志下方、与“对话 / 轨迹”平齐处显示当前 DeepSeek API 账户的可用余额，与按钮居中对齐，页面可见时每 15 秒更新、切回窗口立即更新；悬停可看充值 / 赠送余额拆分。查询由宿主侧发起，密钥不进入网页脚本。
- **统计状态**：输入框下方的统计行使用随主题变化的毛玻璃底板，宽度与输入框一致；系统要求减少透明度或浏览器不支持背景模糊时显示实色底板。
- **人格预设（可选）**：安装对应插件后，可选择“大肥鱼”的强、弱攻击性版本；未安装时不影响其他功能。

桌面端专属插件（统计底板、背景增强）从发布目录直接加载，无需改写或重新安装到 DSH profile；余额插件则是 profile 插件（见上），因为它的宿主半侧要发起 API 请求。现有背景设置继续使用 `dswp:*`。对话历史仍由 DSH 管理。

## 启动、超时与排错

启动链路：后台线程拉起 `dsh web` 的同时初始化 WebView2 → Splash 显示加载动画 → 解析 dsh 打印的带 token 地址并探测 2xx → 加载 UI。

- **超时预算**：0.2.x 的 dsh 要等 profile 合成、全部插件挂载完才打印访问地址，开机初期磁盘/CPU 常被启动项抢占，安装的插件与会话变多后加载也会更久，首次启动可能明显超过 30 秒。默认首次等待 180 秒、重试 180 秒；可用环境变量按秒覆盖（5–3600）：`DSH_DESKTOP_READY_TIMEOUT`、`DSH_DESKTOP_RETRY_TIMEOUT`。
- **超时不杀进程**：等待超时但进程仍在运行时保留它（多半只是慢），只有进程**提前退出**才自动重试一次；重试时若日志显示 `EADDRINUSE` 则改用系统分配的空闲端口。
- **端口**：首选 3080。启动前先探测该端口，被占用（例如上次异常退出留下的 dsh）就直接改用系统端口，不再做一次注定失败的启动。
- **日志**：每次启动写一个 `%LOCALAPPDATA%\DSH_Desktop\logs\launch-*.log`（保留最近 12 个），记录 dsh 定位过程、端口、完整 stdout/stderr 与退出码；失败页会显示日志路径和末尾输出。`DSH_DESKTOP_LOG_DIR` 可改日志目录；`DSH_DESKTOP_DSH` 可显式指定 dsh 可执行文件（非标准安装时使用）。
- **注意**：发布的 exe 不会自动跟随源码更新。改过 `.cs` 后必须重新 `dotnet publish` 再启动，否则运行的仍是旧逻辑（旧版是 30 秒硬等待，会把「启动慢」误报成「未安装 dsh」）。

## 构建与验证

- 发布命令含 .NET 运行时，目标环境仍需 WebView2 Runtime。
- 插件接口在 DSH `0.2.1-rc.2` 验证。注意 0.2.x 会在页面连上 `/plugins/events` 后用 Host 的启动图
  整体对账，桌面注入的 `window.__DSH_BOOT__` 行会被回收；需要常驻的插件应做成 profile 插件，
  而不是靠 `desktop-bootstrap.js` 注入。

```powershell
dotnet build -c Release
dotnet publish -c Release -r win-x64 --self-contained true -o publish
node --test tests/balance.test.cjs
```

测试运行时可通过 `DSH_HOME` 指向独立数据目录、`WEBVIEW2_USER_DATA_FOLDER` 指向独立浏览器数据目录，避免使用真实会话数据。桌面程序不会复用已在运行的 DSH 服务：首选端口被占用时会自动改用系统分配的端口，因此测试端口上即使有服务也不会互相干扰。

## 结构

| 路径 | 作用 |
| --- | --- |
| `MainWindow.xaml.cs` | 窗口初始化、服务启动、WebView 生命周期 |
| `ServerManager.cs` | 查找、启动和停止 `dsh web` |
| `DesktopPlugins.cs` | 本地插件资源与余额宿主桥 |
| `assets/desktop-bootstrap.js` | 启动前合并桌面插件清单、余额消息桥 |
| `plugins/dsh-wallpaper` | 右侧插件图标栏及壁纸设置 |
| `plugins/dsh-balance` | API 余额显示（profile 插件：宿主侧查 `user/balance`，浏览器侧渲染） |
| `plugins/dsh-preset-dafeiyu-strong` | “大肥鱼-强攻击性”Agent 人格预设（可选 profile 插件） |
| `plugins/dsh-preset-dafeiyu-weak` | “大肥鱼-弱攻击性”Agent 人格预设（可选 profile 插件） |
| `plugins/dsh-stats-surface` | 输入框下方统计行的毛玻璃底板 |
| `tests/balance.test.cjs` | 余额插件客户端渲染与宿主路由检查 |

## 后续插件的右侧入口

背景插件通过 `shell.overlay` 提供 `desktop.plugin.action` 列表插槽。后续插件将图标注册到该插槽，按 `order` 从上到下排列；无需再创建独立悬浮按钮。按钮应提供 `title` 和 `aria-label`，保持图标尺寸和交互风格一致。
