# DeepSeek API 余额

Session 页眉第二行（"Session 日志"按钮下方、与"对话 / 轨迹"平齐）显示 `余额：xxx CNY`，与按钮居中对齐，字号与标签一致。页面可见时每 15 秒查询一次，切回窗口时也会更新；失败时保留上一次数值并显示 `余额：--`，鼠标悬停可查看原因（含充值 / 赠送余额拆分）。

## 实现方式

标准的 DSH Web 客户端插件（`dsh.client` + `dsh.bundle.patch`），宿主侧 + 浏览器侧：

- **宿主半侧 `lib/index.js`**：注册一条需要登录态的 Fetch 路由 `GET /api/dsh-balance.balance`，
  向官方 `https://api.deepseek.com/user/balance` 查询。密钥解析顺序：
  1. DSH 凭据存储 `ctx.credentials.resolve('DEEPSEEK_API_KEY')`（即「设置 → 模型」里保存的密钥，
     落在 `$DSH_HOME/.credentials.yaml` 的 `refs` 下）；
  2. 启动环境变量 `DEEPSEEK_API_KEY`。
  密钥只存在于宿主进程，**不会进入网页**。同一进程内 3 秒内的并发请求共用一个上游结果。
- **浏览器半侧 `lib/client.js`**：每 15 秒 `fetch('api/dsh-balance.balance')` 并渲染；
  若宿主路由不可用，会退回桌面桥 `window.dshDesktop.getBalance()`（旧方案，仅用环境变量）。

## 安装 / 更新

```powershell
dsh plugin --profile web add -w D:\DSH\DSH_Desktop\plugins\dsh-balance
```

安装属于 profile 变更，需要重启一次 `dsh web`（桌面端退出后重新打开即可）。
之后只改 `lib/client.js` 时刷新页面即可；改 `lib/index.js`（宿主半侧）需要重启 `dsh web`。
