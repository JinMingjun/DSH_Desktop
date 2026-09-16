# dsh-wallpaper

DeepSeek Harness 背景个性化插件。入口在 DSH 自带侧边栏里：侧边栏展开时位于搜索按钮左侧，收起成竖条时位于搜索按钮下方，仅显示图片图标；点击后在侧边栏右侧展开设置面板，按 Esc 收起。

## 功能

- 通过文件选择器、图片 URL / Data URL 或绝对路径设置背景。
- 预览背景，调节模糊、亮度、饱和度、对比度、透明度及铺满/适应模式。
- 滑杆与数值输入同步；设置实时生效，保存到 localStorage 的 `dswp:*`。
- 单色按钮和面板跟随深浅色主题；按钮尺寸与 DSH 侧边栏自带控件一致（展开 28 px、竖条 36 px，图标 16/18 px）。

| 调节项 | 范围 | 默认 |
| --- | --- | --- |
| 模糊 | 0–60 px | 0 |
| 亮度 | 50–150% | 100 |
| 饱和度 | 0–200% | 100 |
| 对比度 | 50–150% | 100 |
| 透明度 | 10–100% | 85 |

## 桌面端

DSH Desktop 自动加载发布目录中的客户端代码，不需要重新安装 profile 插件。选择图片和 URL 方式可直接使用；**粘贴本地绝对路径**需要原有 host 插件的 `/dsh-wallpaper/read` 端点（已有安装可以继续使用）。该端点只读图片，大小不超过 24 MB。

修改源码后重新构建/发布并重启桌面程序。开发时若直接修改发布目录的 `lib/client.js`，刷新页面即可加载 —— 桌面端每次请求都从磁盘重读该文件并带 `Cache-Control: no-store`，所以**不需要重启程序，F5 即可**。

> 注意：桌面端加载的是**发布目录**的 `publish\plugins\dsh-wallpaper\lib\client.js`，不是本目录的源码。只改源码而不覆盖发布副本，界面不会有任何变化。

## 独立 Web 安装

```powershell
dsh plugin --profile web add -w "<项目绝对路径>\plugins\dsh-wallpaper"
```

安装或修改 `lib/index.js` 后重启 `dsh web`。

## 入口挂载方式

DSH 侧边栏由 `@deepseek-ai/dsh-client-ui-sidebar`（外壳列）和 `@deepseek-ai/dsh-client-ui-workspace`（浏览区）渲染，且两者都没有对外暴露头部动作插槽，因此入口采用 DOM 挂载：

- 定位锚点是浏览区的 `div.sectionHeader`（含 `_sectionHeader` 类名尾缀），并校验其下确实存在搜索控件。
- **展开态**：插到 `div.searchSlot` 之前，并把该槽原本的 `margin-left:auto` 转给自身，从而紧贴搜索按钮左侧。
- **收起态**：`searchSlot` 被卸载、裸搜索控件成为浏览区直接子级，此时插到它后面。
- 类名带构建哈希前缀（如 `bhn1Oq_searchSlot`），所以只匹配稳定的尾缀，不硬编码哈希。
- `MutationObserver` + `requestAnimationFrame` 合并每帧一次重新定位；位置已正确时不重复插入，避免自触发循环。

## 扩展入口

背景插件仍在 `shell.overlay` 里声明 `desktop.plugin.action` 列表插槽（右上角纵向栏，距页面顶部 64 px、右侧 14 px），后续插件可按 `order` 注册图标，自上而下排列；背景插件自身已不再占用该栏。

`lib/client.js` 管理 UI 与壁纸；`lib/index.js` 提供本地图片读取端点；`cordis.patch.yml` 声明 host 插件挂载。
