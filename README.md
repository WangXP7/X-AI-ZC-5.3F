# X-AI 1.0 · 本地视频创作台

依据 `docs/X-AI详细设计文档.md` 实现的纯静态网页视频操作平台：在本机浏览器中编排分镜、
管理图片 / 声音素材，调用 AgnesAI 生成视频，取回后在本地校验、人工审核、按集拼接。
本次实现在应用之外增加了一层**授权密码网关**，使公网可通过 URL 访问但必须先输入授权密码。

## 快速开始

| 步骤 | 操作 |
|---|---|
| 启动本机服务 | 双击 `tools/start-x-ai.cmd`（或 `python tools/server.py --open`），访问 <http://127.0.0.1:8080/> |
| 授权密码 | 保存在 `private/auth-password.txt`；首次运行自动生成并打印在控制台 |
| 发布公网 | 双击 `tools/publish-tunnel.cmd`，按提示用输出的公网 URL 访问（需授权密码） |
| 保持公网在线 | `python tools/tunnel-keeper.py`：断线自动重连（pinggy / serveo 轮换），最新 URL 实时写入 `tunnel/CURRENT-URL.txt` |
| 使用浏览器 | 桌面版 Chrome / Edge（需要 File System Access、Web Locks、Web Crypto） |

生成视频需要使用者自己的 AgnesAI KEY（`sk-` 开头）。发布版不包含任何私人密钥：
在应用右上角“连接与密钥”中粘贴即可，KEY 仅在会话内存中使用。

## 目录结构

```text
app/                 纯静态站点（发布/服务的就是这个目录）
  index.html         固定结构、四页导航、弹窗
  src/*.js           ES Modules：core / storage / credentials / media / engine /
                     batch / references / batch-panel / assets / app / main
  assets/logo.svg    品牌标志
  vendor/ffmpeg*     FFmpeg WASM（本地完整解码与按集拼接）
  cleanup.html       清理本站浏览器数据的小工具页
tools/
  server.py          授权密码网关（Python 标准库；登录会话 + 静态服务）
  start-x-ai.cmd     启动网关并打开浏览器
  publish-tunnel.cmd SSH 隧道发布公网（pinggy.io → localhost.run 依次尝试）
docs/                设计文档与说明（X-AI详细设计文档.md 为设计基线）
private/             授权密码等私人数据（.gitignore 排除，永不出机）
实现说明.md          本次实现的范围、验证记录与已知边界
```

## 授权密码如何工作

- 所有页面与资源（含 JS、WASM、项目数据）必须持登录会话 Cookie 才能访问；未登录访问一律跳转 /login。
- 密码只保存在服务器端 `private/auth-password.txt`，不写入前端代码；密码校验使用恒定时间比较，并有失败限速。
- 会话保存在服务器进程内存，重启服务后需重新登录。`/login` 页设置 Cookie（HttpOnly、SameSite=Lax）。
- 登录页仅额外放行 `assets/logo.svg`（品牌图，不含秘密）。公网侧 HTTPS 由隧道提供。

## 首次使用建议

1. 打开页面 → 点“选择输出目录”授权一个本地文件夹（已有项目会先恢复、已有 references 自动备份）。
2. 右上角启用自己的 KEY，可先“检查连接”（只请求模型列表，遵守 90 秒认证间隔）。
3. 先做一个 4 秒文字任务走通：入队 → 开始队列 → 提交 → 查询 → 下载 → 校验 → 人工审核。
4. 再试参考生成（图 / 声），最后用“多段一次生成”批量清单。

## 重要边界（详见 docs/X-AI详细设计文档.md）

- 平台只做可确定的格式与文件检查；人物一致、剧情、口型、音色需自己观看判断。
- 未知提交（超时 / 无 video_id）队列会暂停并要求人工核实，绝不自动重发，避免重复计费。
- 页面关闭 / 休眠会暂停本地执行；已提交的云端任务可能继续，恢复优先保留原 video_id。
- 每次认证请求间隔 ≥90 秒；一次只有一个在途生成任务。
