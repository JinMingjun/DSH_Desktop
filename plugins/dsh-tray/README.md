# dsh-tray

DSH Desktop 的可选 Windows 托盘插件。它只在 DSH Desktop 的 WebView2 宿主中生效：

- 插件开启时，关闭主窗口会隐藏到 Windows 通知区域，DSH 服务继续运行；
- 左键单击托盘图标恢复原窗口；
- 右键菜单提供最近 5 个未归档对话、新建对话和退出；
- 插件关闭时撤销托盘图标，并恢复“关闭窗口即退出”的原逻辑。

## 安装

```powershell
$trayPlugin = (Resolve-Path .\plugins\dsh-tray).Path
dsh plugin --profile web add -w $trayPlugin
```

安装后可在 DSH 的统一插件管理页面开启或关闭 `dsh-tray`。开关由 DSH 的插件生命周期
实时同步到桌面宿主；退出菜单会真正停止由桌面客户端启动的 `dsh web` 进程。

本插件的 `lib/index.js` 是用于统一插件管理的 Host 空实现，`lib/client.js` 负责读取 DSH
会话目录并调用官方的会话导航服务；Windows 托盘本身由 `TrayController.cs` 实现。
