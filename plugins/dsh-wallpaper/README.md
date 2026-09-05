# dsh-wallpaper — DSH Web UI 全局壁纸插件

给 DeepSeek Harness Web UI 增加一个**右上角悬浮按钮**（自动与「对话/轨迹」
标签下方分割线对齐）：点击后展开一个 VSCode 风格的侧栏，选择一张图片作为
**整个 UI 的全局背景**，并可实时调节：

| 调节项 | 范围 | 默认 |
| --- | --- | --- |
| 模糊 blur | 0 – 60 px | 0 |
| 亮度 brightness | 50 – 150 % | 100 |
| 饱和度 saturation | 0 – 200 % | 100 |
| 对比度 contrast | 50 – 150 % | 100 |
| 透明度 opacity | 10 – 100 % | 85 |
| 适配 fit | 铺满 / 适应 | 铺满 |

每个滑杆旁边都有**数字输入框**（可滑动、也可直接键入数值，回车/失焦生效）。

## 功能

- **选图（三种方式）**：
  1. **文件选择器** — 「选择图片…」按钮实际是一个覆盖按钮的隐藏文件框
     （label 包裹），用户点击直接命中 `<input type=file>`，在浏览器与
     WKWebView（桌面 App）中都能弹出原生选择面板；
  2. **粘贴绝对路径** — 输入图片的完整绝对路径（如
     `/Users/你/Pictures/a.jpg`）点「加载」，由插件的 host 端点
     `GET /dsh-wallpaper/read?path=…` 读取并转成 data URL；
  3. **粘贴 URL / Data URL** — 直接填网页图片链接。
- **预览**：侧栏顶部实时预览当前背景。
- **全局背景**：图片作为固定底层铺在整个 UI 之后；主内容区与侧边栏变半透明
  露出图片，消息、输入框等内层表面保持不透明以保证可读性
  （通过 `ctx.theme.overrideTokens` 覆盖 `--dsw-alias-bg-base` 与
  `--dsw-specific-sidebar-fill`）。
- **调节**：模糊/亮度/饱和度/对比度/透明度，滑杆 + 数字输入双向同步，
  实时生效；另有「重置调节」「移除背景」。
- **持久化**：全部设置存 localStorage（`dswp:*` 前缀），刷新页面后保留。
- **跟随主题**：深浅色切换时自动按当前主题底色重新着色。
- **按钮对齐**：运行时自动寻找「对话/轨迹」标签行，把按钮顶部与分割线对齐
  （窗口大小变化会重新对齐）。

## 安装（已安装到你的 web profile）

```sh
cd ~/Documents/dsh-wallpaper
dsh plugin --profile web add -w "$HOME/Documents/dsh-wallpaper"
```

安装后**必须重启 `dsh web`**（插件集合变化需要重启）；此后修改
`lib/client.js` 只需刷新页面（bundle 按请求实时读取）。

> ⚠️ **修改 `lib/index.js`（host 端）后也需要重启 `dsh web`**：路径加载接口
> `/dsh-wallpaper/read` 是 host 插件在启动时注册的 HTTP 路由，重启前访问
> 会得到 404（界面会提示「读取失败」，重启后即可用）。

## host 端点安全限制

`/dsh-wallpaper/read` 仅接受：图片扩展名（png/jpg/jpeg/gif/webp/bmp/avif/svg）、
绝对路径、≤24MB；跨域来源（非 127.0.0.1/localhost）会被拒绝。


## 验证

- `dsh --profile web --dump-config | grep wallpaper` 出现 `dsh-wallpaper` 层；
- Network 面板出现 `/plugins/dsh-wallpaper/client.js?rev=...` 返回 200；
- 页面右侧出现悬浮按钮，点击展开侧栏。

## 卸载

```sh
dsh plugin --profile web remove dsh-wallpaper
```

重启后生效；浏览器侧 localStorage 键（`dswp:*`）可手动清除。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `lib/client.js` | 全部功能（按钮、侧栏、调节、壁纸引擎）。改这里。 |
| `lib/index.js` | host 半面（无操作占位）。 |
| `cordis.patch.yml` | 插件挂载声明（插入配置树）。 |
| `package.json` | 包元数据与 `dsh.client` 声明。 |

## 想自定义？

- **按钮位置/样式**：`lib/client.js` 里 `.dswp-btn` 的 CSS（右侧中部悬浮，
  改 `right` / `top` 即可）。
- **调节范围**：`LIMITS` 常量表。
- **UI 文案**：`T` 对象（当前为中文）。
