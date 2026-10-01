# X-AI 1.0 详细设计文档

> 产品：X-AI · 本地视频创作台<br>
> 文档基准日期：2026-10-01（北京时间）<br>
> 代码目录：`PRIVACY-REDACTED\REDACTED-DIR`<br>
> 面向读者：产品负责人、普通使用者、前端开发者、音视频开发者、测试人员及接手开发的 AI。<br>
> 文档性质：当前实现说明 + 设计约束 + 扩展方案。不是服务商永久规格承诺，也不是历史视频生产已全部完成的证明。

## 0. 阅读方式、状态标记与依据

### 0.1 阅读路径

|读者|建议先读|主要问题|
|---|---|---|
|普通使用者|第 1、3、5、6、9、12、13、16、18 章|怎样准备材料、提交、恢复、审核和保存文件|
|产品或设计人员|第 2、3、4、5、6、16、21 章|功能边界、交互状态、错误恢复、可读性|
|接手开发者 / AI|第 7、8、10—15、17、19—25 章|源码、数据协议、状态机、不重复计费、测试和扩展|
|测试人员|第 9、12—16、20、23、26 章|限制、失败分类、版本恢复、验收场景|

本文件是可维护的主文档。旁边的 `X-AI详细设计文档.html` 是供浏览器阅读的派生版本；修改设计时先改 Markdown，再重建 HTML。阅读版不加载 API 密钥，不调用生成服务，也不操作用户项目。

### 0.2 文档用语

- **已实现**：当前源码中存在相应逻辑，不代表所有外部服务条件都已验证。
- **已验证**：有仓库验证记录支持；应区分模拟网络、真实本地媒体处理和历史真实认证。
- **设计约束**：开发时必须保持的行为，例如未知提交不能自动重发。
- **后续设计**：建议的扩展，不应向使用者宣称已提供。
- **技术通过**：文件、媒体及程序规则通过；不等于人物、剧情、动作、口型和声音正确。
- **人工内容通过**：使用者明确确认观看、听审后记录的结论。
- **原路径素材**：由清单定位到外部素材目录的文件；平台不把它复制到输出目录。
- **管理副本**：用户直接选择 / 拖入文件后，平台为管理而保存的浏览器副本及可选磁盘副本。
- **当前版本**：`job.current` 所指的具体视频、哈希和检查记录；不是根据文件名推测的“最新文件”。

### 0.3 依据与冲突处理

设计依据为本轮用户要求、项目 `AGENTS.md`、当前 `index.html` / `src/` / `tools/`、README、专题使用说明和 `docs/验证记录.md`。正文按当前最终版组织；历史记录里仍可能有此前的复杂密钥入口、宣传页头、生成日期等描述，不应据此恢复已被用户否定的界面。

此次文档整理没有新建收费视频，没有重新声称完成 379 镜 / 40 集任务，没有重新验证服务商价格、余额、配额或所有下载域名。历史长任务提供流程经验；平台自身验证证据见第 20 章。

## 1. 产品目标与运行边界

### 1.1 产品定位

X-AI 是一套纯静态、可发布到 GitHub Pages 的网页视频操作平台。用户在自己的浏览器中编排分镜，选择本地图片和声音，调用 AgnesAI 生成视频，取回后在本地检查、审核和按集拼接。

平台不依赖对话 AI 在旁边逐步操作。用户完成一次清单、素材和参数准备后，可启动有状态、可恢复的串行队列。平台直接处理可确定的格式与文件问题；剧情拆解、角色一致性、音色身份等语义问题由使用者或外部工具判断。

### 1.2 本地、服务商和网站分别做什么

|位置|承担工作|保存 / 接触的数据|
|---|---|---|
|静态网站 / GitHub Pages|提供 HTML、CSS、JS、SVG、WASM、说明文档|公开代码和公开第三方资源；不应含私人密钥和素材|
|用户浏览器|表单、清单解析、文件读取、SHA-256、队列、预览、校验、WASM 拼接|项目工作副本、选中的素材、已下载媒体；密钥在会话内存|
|用户磁盘|项目记录、管理副本、优化版、原始下载、单镜、核验材料、分集片|用户实际输出及可迁移备份|
|AgnesAI|认证、任务创建、排队、模型生成、状态查询|每次实际提交的提示词和选定参考素材|
|结果媒体服务 / CDN|返回已生成视频|视频文件；不应收到 AgnesAI Authorization|
|可选本机连接器|绕开浏览器跨域限制，转发受限路由|经过转发的请求；不保存明文密钥或请求内容|

“本地运行”指网页业务逻辑和文件处理在用户电脑；不表示在本地离线运行生成模型。提示词和参考素材在创建请求时会发送给服务商。访问 Pages 仍需要联网；已加载的部分本地操作可继续，但没有完整离线应用保证。

### 1.3 当前范围

已实现：单段编排；多段清单编排；文本引用递归展开；图片 / 声音素材库；批量图片优化；素材 ZIP；三种生成模式；串行限流；断点恢复；下载；本地媒体校验；人工审核；历史尝试；按集拼接；过程 MD；静态发布。

目前不提供：自动剧本创作、语义拆镜、图像生成、声音克隆、内置 Whisper、AI 视觉审片、视频作为参考输入、多模型实际调用、自动无限付费重做、服务端后台调度、关闭页面后的持续运行、多个设备之间的账户级统一锁。

## 2. 用户需求与落地规则

|需求|当前落地|开发不可破坏的规则|
|---|---|---|
|纯静态且脱离 AI 独立操作|原生 ES Modules + 浏览器文件 / 媒体能力|不得把关键业务移到必须依赖的云端后台|
|单段与批量界面有明显区别|独立 fieldset、独立参数、独立参考列表、不同底色 / 主按钮|批量页不展示单段提示词、单镜上传框和单镜参数|
|常用密钥简单|自动启用本机私有默认配置；可直接填写自己的 KEY|普通模式不展示口令 / 加解密复杂流程|
|保留高级密钥能力|默认收起的高级模式|导入候选未成功解锁前不覆盖已有加密副本|
|提醒本地目录|名称、状态、保存位置、备份结果可见|浏览器不给完整盘符时不能伪造完整路径|
|已有 references 保护|选择目录时递归备份并核对哈希；覆盖前再次备份|备份失败停止后续写入|
|清单已有路径就直接引用|原路径来源记录、句柄回读、哈希校验|不复制原素材，不改源清单字节|
|优化版仍好追踪|合法格式尽量同名写入 references，记录替代映射|扩展名必须对应真实编码；不同来源同名不得互相覆盖|
|大批素材有进度|预检说明、当前文件 / 阶段、进度、逐项结果|完成当前项后停止；已完成结果保留|
|长条图尽量全图显示|contain、宽卡片、全图放大预览|不得通过裁掉头脚填满卡片|
|CSV 支持明确分隔和文件引用|分隔符识别、中文表头、路径 / 编号、递归文本|不能把模糊引用猜成实际文件|
|限制与失败清晰|4—12 秒、90 秒认证间隔、一个远端任务、错误 + 操作按钮|未知 POST 不盲重发；查询超时沿原 video_id|
|生成结果须校验|元信息、抽帧、哈希、完整解码、人工复核|技术通过不能自动成为艺术通过|
|模型入口可扩展|真实原生下拉框，目前仅一个选项|添加名称前必须实现该模型完整调用和恢复|
|品牌署名|X-AI 1.0 与 ® YiQiXP 同一行，下一行艺术字|不恢复此前被否定的多行版权日期块|

## 3. 主要使用流程

### 3.1 单段流程

1. 打开 localhost 或 HTTPS 页面，等待初始化结束。
2. 选择输出目录；遇到已有项目先恢复并核对，已有 references 自动备份。
3. 确认密钥已启用；需要时检查连接。
4. 选择“单段生成”，填写镜号、分组、画面动作、时长、比例、生成模式。
5. 参考模式从本地素材库选择或直接添加文件；首尾帧模式明确选择帧；对白单独填写。
6. 点击“检查并加入队列”。程序列出错误和警告；有错误则不入队。
7. 在任务页点击“开始 / 继续队列”。提交前保存检查点，开始串行生产。
8. 生成完成后下载、检查、预览。使用者观看和听审，确认通过或标记具体原因。
9. 若为分组的一镜，其他镜完成后可按集拼接；整集仍需观看审核。

### 3.2 多段流程

1. 切换“多段一次生成”，单段操作区隐藏并禁用。
2. 粘贴清单或导入 CSV / TSV / JSON / TXT。
3. 清单有相对路径或引用其他文件时，选择清单与素材共同上级目录，在下拉中指定清单位置。
4. 点击“读取引用并展开”：先确定文本和素材路径，展示来源与替换；有歧义 / 缺失则整批停止。
5. 对定位到的实际素材显示预检清单，再由使用者开始导入，看到逐项进度。
6. 预览字段和素材映射；必要时打开“批量默认设置”，补齐清单缺省参数。
7. 点击“检查整批并加入队列”：重新核对文本来源哈希及每镜组合；任一镜错误都不部分入队。
8. 启动队列。批量是多镜一次准备、按序逐镜运行，不是多任务并发。
9. 每镜保留独立 video_id、下载和 QA；每组按实际当前版本拼接。

### 3.3 中断恢复流程

```mermaid
flowchart TD
  A[重新打开 X-AI] --> B[取得本网站工作台锁]
  B --> C[读取项目工作副本或恢复磁盘项目]
  C --> D[重新启用密钥与文件权限]
  D --> E{最后任务是否有 video_id}
  E -->|有| F[继续查询原编号或重新下载]
  E -->|没有且提交曾开始| G[提交结果待核实]
  E -->|没有且从未提交| H[校验后待提交]
  G --> I[找到原编号并绑定]
  G --> J[记录已核实未创建的依据]
  I --> F
  J --> H
```

页面关闭 / 电脑休眠会暂停本地执行。已经提交的云端生成可能继续。恢复必须优先保留其编号和证据；不能为获得“干净状态”而删除最后一次尝试。

## 4. 页面结构与视觉规范

### 4.1 信息架构

固定侧栏提供四个入口：创作工作台、任务与成片、本地素材库、操作指南。底部是本地说明卡、连接与密钥、版本署名和艺术字。主区域顶栏提供当前位置、密钥载入状态、帮助。创作区顶部直接显示本地文件夹和项目数量概况。

工作台无大型装饰 Hero，内容宽度不再限制在旧的 1530px 上限，以保留有效操作面积。任务总数、已生成数、素材数均来自实际项目数据，不是示例数字。

### 4.2 品牌

- Logo：`assets/logo.svg`，64×64 viewBox；深色圆角底、两条交叉 X 形带、紫色渐变、中央播放三角的组合。
- 标准名称：X-AI；辅标 VIDEO STUDIO。
- 左下版本：`X-AI 1.0　® YiQiXP`，同一行。
- 最底艺术字：`让X-AI把你的故事美梦成真！`；楷体优先、本机字体回退、轻斜体、紫色渐变。
- 标语卡：明确两行“你的文件，” / “你的电脑”；两行同左边缘。
- 操作指南：描边书本 SVG；圆圈符号已替换，避免误认为单选选中状态。
- 不展示“最新生成日期”版权块；文档日期与产品底部布局是不同信息。

### 4.3 字号、颜色、间距

正文基准 15px / 约 1.65 行高；功能与辅助说明通常不低于 14px。背景为暖灰 `#f6f6f3`，正文 `#252633`，辅助文字主要 `#656270`。单段主按钮为蓝绿色 `#286575`，批量主按钮 `#6750cc`、表单底色 `#f5f1fd`。警告和错误使用文字、图标 / 状态及边框共同表达，不能只依赖颜色。

按钮至少有明确文字、合理点击面积、焦点样式；轻量动作使用带间隔的浅边框按钮。批量清单的“示例 / 导入 / 模板”等不能挤成一串文字链接。

### 4.4 响应式

|范围|侧栏|主要行为|
|---|---|---|
|宽桌面|220px|完整标志、导航文字、说明卡、署名和艺术字|
|≤1150px|185px|缩小侧栏宽度；正文仍保持可读；艺术字调整为 14px|
|≤900px|76px 图标栏|隐藏品牌辅文、说明卡、版本和艺术字|
|≤600px|58px 图标栏|表单单列，轻量按钮换行，模型完整规格补充显示|

390px 页面已检查无横向溢出，但核心自动写目录仍以桌面 Chrome / Edge 为运行目标。响应式可见不代表所有移动浏览器文件能力相同。

### 4.5 弹窗与错误层级

采用原生 `<dialog>` / `showModal()`。弹窗在浏览器 top layer，普通页面 toast 即使提高 z-index 也可能被遮罩挡住。设置窗口的错误固定进入弹窗底部反馈区，相关字段可标红 / 聚焦；其他弹窗把通知插入自己内部。任意 modal 打开时隐藏背景 toast 容器。

## 5. 创作工作台详细交互

### 5.1 单段操作区

|字段|类型 / 默认|校验 / 行为|
|---|---|---|
|镜号|字符串，初始 S01|安全 ID；唯一；最长 64 位|
|分集 / 分组|字符串，初始 EP01|安全 ID；作为文件目录及拼接组|
|画面与动作|多行文本|必填，最多 12000 UTF-16 长度计数；一镜一个主要动作由用户保证|
|生成方式|text / reference / keyframe|模式组合规则见第 9 章|
|片段时长|整数，默认 8|4—12 秒|
|画面比例|枚举，默认 9:16|支持的六种比例|
|参考素材|图片 / 声音列表|图 ≤5，声 ≤3，总时长及实际字节检查|
|首帧 / 尾帧|图片 ID|仅 keyframe，至少一个，不能携带参考声音|
|指定对白|字符串，可空|独立于动作；空值生成无对白约束|
|随机种子|可空整数|0—2147483647|

“填入示例”只填示例文本，不创建任务。“补充画幅与对白约束”添加确定性的运行约束，不调用大模型重写剧情。单段成功入队后可生成下一个未使用的 Sxx 镜号；批量入队不改写单段镜号。

### 5.2 批量操作区

直接显示清单输入、导入按钮、源目录选择、读取引用、字段预览、共用素材库和可下载展开清单。默认参数折叠在“批量默认设置”，包含默认时长、比例、分组、镜号前缀、共用素材。

显示与禁用必须同步：`single-editor.hidden/disabled` 和 `batch-editor.hidden/disabled`。仅 CSS 隐藏必填字段仍可能被浏览器 required 校验阻止提交；disabled 的 fieldset 也可从键盘路径中移除非当前控件。

单段 `selected` 与批量 `batchSelected` 分开。切换保留本页草稿；这些输入草稿没有独立自动持久化保证，刷新页面前应导出清单或入队保存。

### 5.3 模型下拉框

原生 `select#video-model`，标签“视频生成平台与模型”。当前唯一选项：

`AgnesAI · Agnes Video 2.5 Flash · 720P · 最长 12 秒`

值为 `agnes-video-2.5-flash`。单段和批量共用此选择框。手机下方另显示完整模型名及 `720P · 最长 12 秒`，避免原生长选项被截断后看不到限制。

当前后端调用仍使用 `core.MODEL` 常量；没有多模型选择变更事件，也没有逐任务 provider / model 配置字段。唯一选项与实际请求已核对一致。将来不能仅增加 option 就认为接入新模型，完整方案见第 22 章。

### 5.4 入队是一个整批检查点

点击提交后，解析每镜 spec → `newJob` → `validateJob`。校验时同时包含已有任务和本批任务，避免本批内部重复镜号。所有错误与警告显示出来；任一错误拒绝整批。全部格式通过则一次加入 `project.jobs`，记录 `input_approved` 事件，保存项目并进入任务页。

## 6. 本地目录、权限与文件保护

### 6.1 两种目录职责

**输出目录**通过 `showDirectoryPicker({id:'x-ai-output',mode:'readwrite'})` 选择，负责写入生成产物、管理副本和优化版。**源目录**通过 `showDirectoryPicker({id:'x-ai-input',mode:'read'})` 选择，负责清单和外部素材只读定位。两者可以不同；推荐代码仓库、源素材、生产输出分开。

浏览器只暴露授权目录名和可遍历的相对路径，不保证提供 `D:\...` 完整绝对路径。界面显示目录名、授权状态和相对保存位置，并说明这一边界。不能凭用户选择的名称拼出未经验证的盘符。

### 6.2 选择输出目录的顺序

1. 确认没有生产、素材操作或目录操作正在占用。
2. 检查候选目录 `project.json`。
3. 有项目则询问恢复；取消不写入候选目录。恢复前按记录核对媒体。
4. 检查 `references` 下已有文件；递归备份到 `backups/references_时间_随机后缀/`。
5. 每文件计算 SHA-256，复制后回读备份文件计算同一哈希；写备份 manifest。
6. 备份成功后才把候选设为输出目录并保存句柄 / 项目。
7. 从浏览器工作副本镜像文件到新目录时，跳过 `storage:'source'` 原路径素材。

这是文件层面的保护顺序，不是跨 IndexedDB 与磁盘的事务。意外断电、磁盘失败或复杂恢复中断仍可能留下部分备份文件；不能宣称所有多文件写入具有数据库式原子回滚。

### 6.3 原素材直接引用

清单提供路径时保留 `sources`、`aliases`、原始文件名和哈希，`storage:'source'`。浏览器为预览可保留缓存；输出目录不再复制原件。提交时有有效源句柄则回读文件，验证 SHA-256；有句柄但权限 / 文件失效时明确阻断，不静默改用过期缓存。

没有目录句柄的 fallback 只能读取用户已选择的 File 缓存，不能继续任意读取未授权磁盘路径。其外部源变化检测能力相应减弱。

### 6.4 优化文件与路径映射

原路径素材符合 PNG/JPEG/WebP 时，优化版尽量保留同名及真实格式，存在 `references/原文件名`。声音同样尽量保留原扩展名及真实编码。其他不支持作为请求输入的图像格式可转 JPEG 并合理改后缀，不伪造同名格式。

若两个来源同名，或原文件自身就在目标 references 路径，改用 `references/原素材ID/原文件名`，保留文件名并避免覆盖原件。`derivedFrom` 指回原资产，原资产 `effectiveAssetId` 指向合规优化版；`reference-mapping.json` 记录原路径 / 哈希与有效路径 / 哈希。

新分镜解析及尚未提交的无尝试任务可切换有效素材；已提交、已生成任务的尝试快照不回写。源 CSV 不改字节；运行时采用映射。写入已有管理素材目标路径前再次备份旧字节，旧资产记录可更新为备份路径。

### 6.5 标准输出树

```text
输出目录/
  project.json
  reference-mapping.json
  X-AI_制作过程与结果.md
  references/
    受管理的导入副本或同名优化素材
    原素材ID/同名冲突时的优化素材
  backups/
    references_时间_随机后缀/references/...
    references_时间_随机后缀/manifest.json
    replaced_时间_随机后缀/原相对路径
  raw/EP01/S01_v1.mp4
  clips/EP01/S01_v1.mp4
  checks/S01_v1/
    frame_1.jpg ... frame_5.jpg
    last.png
    report.json
  episodes/
    EP01_v1.mp4
    EP01_v1_inputs.json
```

同一尝试重新下载得到不同字节时使用 `_d2` 等下载序号，保留旧文件 / `downloadHistory`。raw 与 clips 当前保存相同视频字节：raw 是原始下载记录，clips 是经校验登记的剪辑入口，当前没有自动裁切或重新编码单镜。

## 7. 技术架构与源码职责

```mermaid
flowchart LR
  UI[index.html + style.css] --> APP[app.js 工作台协调]
  APP --> BATCH[batch.js / batch-panel.js]
  BATCH --> REF[references.js 递归解析]
  APP --> ASSET[assets.js 素材操作]
  ASSET --> MEDIA[media.js 本地音视频]
  APP --> CRED[credentials.js]
  APP --> RUN[engine.js Runner / Transport]
  RUN --> API[AgnesAI / HTTPS 媒体]
  RUN --> MEDIA
  APP --> STORE[storage.js]
  REF --> STORE
  ASSET --> STORE
  RUN --> STORE
  STORE --> IDB[IndexedDB 工作副本]
  STORE --> DISK[授权本地目录]
  MEDIA --> WASM[FFmpeg Worker + WASM]
```

### 7.1 模块表

|文件|主要职责|关键入口|
|---|---|---|
|index.html|固定结构、表单、dialog、导航和模型入口|DOM ID 与 data-* 动作|
|src/style.css|密度、模式区分、预览、反馈及响应式|模式 / 状态类及断点覆盖|
|src/app.js|初始化、页面协调、按钮、入队、目录 / 恢复、人工审核|init、ensureIdle、defaults、render、openDetail|
|src/core.js|通用规则、状态标签、ID / 路径 / 项目检查、脱敏、密钥加密|validateJob、newJob、makeProject、validateProjectFile|
|src/batch.js|CSV / JSON / 文本解析、字段别名、素材查找、spec 生成|inspectBatch、parseCSV、parseBatch、findAsset|
|src/batch-panel.js|源目录索引、清单加载、预览、读取与入队前复核|choose、prepare、specsForQueue|
|src/references.js|文本 / 素材上下文递归、定位、去重、来源哈希|needsResolution、resolveReferences、verifyResolvedDocuments|
|src/assets.js|素材预检、进度、停止 / 继续、复用、批量优化、预览|planImport、planOptimize、execute、activateReplacement|
|src/archive.js|不重编码 ZIP，UTF-8 名称、CRC32、大小限制|createArchive、archiveNames|
|src/storage.js|IndexedDB、文件句柄、读写 / 备份、恢复、项目 / MD|saveProject、readAsset、backupReferences、restoreProjectFiles|
|src/credentials.js|普通密钥、默认配置、高级保险箱、固定反馈|initialize、loadDefault、unlock、useNew|
|src/local-default.js|本机免口令 AES-GCM 封装|sealLocalDefault、openLocalDefault|
|src/media.js|素材元信息、转换 / 裁切、Data URI、抽帧、解码、拼接|importAsset、inspectVideo、deepCheck、concatenate|
|src/engine.js|认证节流、请求 / 查询、尝试状态、结果接受、修订 / 拼接|Transport.api、Runner.start、step、payload、acceptFile|
|tools/serve.py|仅回环地址的开发静态服务|端口 4173，支持测试前缀|
|tools/connector.py|可选 CORS 本机连接器|固定上游、来源 / 配对码、90 秒节流|

### 7.2 初始化顺序

安全上下文 / Web Locks / Web Crypto 能力检查 → 取得 `x-ai-studio-tab` 独占锁 → 读取并校验 IndexedDB 项目 → 读取输出句柄 → 创建 Runner / 素材库 / 批量面板 / 密钥面板 → 自动加载默认密钥 → 恢复中断状态 → 保存工作副本 → 渲染并绑定事件 → 设置 `document.documentElement.dataset.ready='true'`。

第二个同网站页面未取得锁时，只显示“另一个页面正在使用”和重新连接入口，不先载入 / 修改项目再阻止。浏览器自动化检查必须等 ready，再点击控件。

### 7.3 本地状态与并发

- `x-ai-studio-tab`：同源工作台实例锁，整个页面生命周期持有。
- `x-ai-production-runner`：队列运行锁。
- `x-ai-auth-http`：认证请求锁，等待节流并发出请求。
- `saveProject` 内部 Promise 链：串行写项目快照，避免保存相互覆盖。
- `serialFF`：串行使用单个 FFmpeg 引擎。
- `ensureIdle`：目录、素材、递归解析或队列运行时限制会改写记录的操作。

这些锁是同浏览器同源范围。不同端口 / 域名、其他浏览器、其他设备或外部生产脚本没有统一锁。

## 8. 数据模型与持久化协议

### 8.1 记录原则

项目 JSON 保存可解释、可迁移的状态和证据；媒体二进制放在 IndexedDB `blobs` 及本地文件。JSON 不包含明文 API KEY、解锁口令、连接器配对码或完整 Data URI。请求体保存脱敏摘要与完整请求哈希；哈希可供同一份输入复核，不可从哈希还原请求。

浏览器数据库名 `x-ai-studio`，当前版本 1；object stores 为 `state`、`blobs`、`handles`。`state/project` 是项目工作副本，`state/rate` 为认证请求时间槽，`state/vault` 是用户主动保存的加密副本。句柄不序列化到项目 JSON。

### 8.2 Project

|字段|类型|语义|
|---|---|---|
|schema|string|固定 `x-ai-project-v1`；恢复前校验|
|id|string UUID|项目身份；不能把另一个项目的记录覆盖在途任务|
|name|string|项目名；默认“我的视频项目”|
|createdAt / updatedAt|ISO 时间|UTC 序列化；界面可按用户时区显示|
|jobs|Job[]|执行顺序即数组顺序；当前最大支持 1000 镜的记录校验|
|assets|Asset[]|原始与派生资产记录|
|episodes|Episode[]|每集所有成片版本，不只留最后一个|
|events|Event[]|过程事件；当前是 JSON 内数组，不是独立 events.jsonl|
|settings|object|origin、connection、gap；不保存密钥|

`settings.origin` 只能来自固定 Agnes 域名列表；`connection` 为 direct / bridge；gap 在恢复及设置时限定 90—3600 秒。`updatedAt` 主要由事件记录更新，不能视为每个字节改动的严格事务时间戳。

### 8.3 Job

|字段|类型 / 常见值|用途|
|---|---|---|
|uid|string UUID|不随用户镜号变化的任务身份；Blob key 使用它|
|id|string|可读镜号，如 A01-01；同项目唯一|
|episode / episodeTitle|string|安全分组 ID；可保留中文原集名|
|prompt / dialogue|string|已确认入队的画面文本和对白快照|
|seconds|integer|4—12|
|aspect|string|比例枚举|
|mode|string|text / reference / keyframe|
|seed|integer / null|可选随机种子|
|assetIds|string[]|选用的有效参考 Asset ID，稳定顺序|
|firstFrame / lastFrame|string / null|首尾帧 Asset ID|
|continuityFrom|string / null|上一镜镜号，用于真实结束画面衔接|
|sourceReferences|string[]|源清单素材写法，用于追踪|
|textSources|TextSource[]|文本来源、定位、编码、链及哈希|
|referenceReplacements|Replacement[]|prompt / dialogue 替换前后|
|state|string|生成与处理状态，见第 12 章|
|review|string|pending / approved / rejected|
|attempts|Attempt[]|每次收费生成尝试及拒绝 / 不明记录|
|current|Attempt 副本 / null|当前剪辑版本的路径、哈希、QA|
|error|string / null|短原因；原接口细节在尝试记录|
|progress|number|服务商返回进度；不保证连续 / 准确 / ETA|
|revisionReason|string|本次准备重做原因|
|createdAt / updatedAt / reviewedAt|ISO 时间|创建、可选更新、人工审核时间|

`current` 当前采用 JSON 深拷贝尝试对象；开发时要同步关注尝试与当前副本，不能只修改其一。UI 的 V 编号当前使用尝试数，含尚无视频的拒绝记录，不等价于“已有 V 份成片”。

### 8.4 Asset

|字段|类型|用途|
|---|---|---|
|id|string UUID|资产精确身份|
|kind|string|image / audio|
|name / type|string|文件名、浏览器 MIME；格式仍需真实解码 / 编码核对|
|bytes|number|文件大小|
|sha256|string 64 位十六进制|内容指纹 / 完整性|
|errors|string[]|尺寸、格式或大小问题；可存入库，但不可直接提交|
|width / height|number|图片实际解码尺寸|
|duration|number|声音真实媒体时长|
|blobKey|string|IndexedDB 二进制位置|
|path|string|输出相对路径或源目录相对路径|
|storage|`source` 或未设置|source 为外部原路径；未设置为管理 / 派生输出|
|sources|Source[]|源目录 root UUID、rootName、相对 path|
|aliases|string[]|清单编号等别名|
|derivedFrom|string|指向原资产 ID|
|transform|string|尺寸 / 格式 / 裁切说明|
|effectiveAssetId|string|原资产当前合规派生版 ID|

同字节文件按哈希复用，同时合并本次路径和编号。哈希不用于人物身份识别；两张不同图即使同名也不能当相同资产。当前 `validateProjectFile` 对元数据有基本结构校验，不是完整 JSON Schema 安全证明，后续扩展须继续收紧未覆盖字段。

### 8.5 Attempt

|字段组|主要字段|说明|
|---|---|---|
|尝试身份|number、createdAt、submittedAt、reason|number 从 1 增长；先记录后 POST|
|输入快照|snapshot、inputHashes、request、requestHash|snapshot 含文本 / 参数 / IDs；request 为脱敏请求|
|远端身份|videoId、taskId|videoId 单独取，taskId 仅补充，不得替代|
|远端结果|response、submitError、pollResponse、polledAt、url|脱敏；最终 HTTPS 媒体 URL|
|重试控制|deferrals、queuePolls、pollErrors|限流 / 排队 / 查询失败计数|
|终止证据|resolved、terminalConfirmed、rejectedBeforeCreation、uncreatedEvidence|是否已确认结束 / 未创建；不能从一次超时推断|
|原始下载|rawBlobKey、rawPath、rawSha256|最早保存的原始文件|
|校验文件|blobKey、path、sha256、bytes、downloadedAt、qa|经检查登记的视频与结果|
|抽帧|frameDirectory、frameKeys、lastFrameKey / Path / Sha256|五点抽帧及结束附近画面|
|衔接输入|continuityInput|前镜镜号、末帧路径 / 哈希、前镜视频哈希|
|下载换版|downloadSequence、downloadHistory、forceDownload|同一 video_id 不同下载字节保留历史|

### 8.6 QA / Episode / Event / TextSource

**QA**：duration、width、height、fps、hasAudio、fullDecode、technical、fatal[]、warnings[]、darkRatios[]、error。`fullDecode` 是 passed / failed / not_run，`technical` 是 passed / failed / partial；元信息或抽帧异常可能中断检查进入 blocked，应保留原始下载。

**Episode**：id、version、path、sha256、blobKey、seconds、inputs[]、createdAt、fullDecode、review。inputs 每项包含 id、path、sha256，表示这次实际剪辑输入。review 当前为说明性字符串；没有独立完整的整集批准工作流。

**Event**：at、kind、message、jobId。message 经过密钥模式脱敏。当前事件保存在 project.events，随项目与过程 MD 输出；没有独立数据库日志轮转或全量 HTTP 时序遥测。

**TextSource**：root、path、sha256、encoding、field、selection、chain。入队保存所用文本及来源，而不是持续引用一个可能变动的文件。Replacement 含 field、before、after；通常每镜最多 prompt / dialogue 两项。

### 8.7 最小项目示例

下面是结构说明；UUID 和哈希均为示例，不可当作真实恢复记录直接投入生产。

```json
{
  "schema": "x-ai-project-v1",
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "森林短片",
  "createdAt": "2026-10-01T00:00:00.000Z",
  "updatedAt": "2026-10-01T00:00:00.000Z",
  "settings": {"origin": "https://api.agnes-ai.cn", "connection": "direct", "gap": 90},
  "assets": [],
  "episodes": [],
  "events": [],
  "jobs": [{
    "uid": "22222222-2222-4222-8222-222222222222",
    "id": "S01", "episode": "EP01", "prompt": "小熊走向森林中的灯光。",
    "dialogue": "", "mode": "text", "seconds": 8, "aspect": "9:16", "seed": null,
    "assetIds": [], "firstFrame": null, "lastFrame": null, "continuityFrom": null,
    "state": "pending", "review": "pending", "attempts": [], "current": null
  }]
}
```

## 9. 校验规则、自动修正与处理边界

### 9.1 三层检查

1. **单文件检查**：读取、哈希、解码、格式、尺寸 / 比例、声音元信息。
2. **分镜组合检查**：参数、模式、数量、声音总长、占位编号、连续引用、请求体大小。
3. **输出媒体检查**：容器、时长、分辨率、画幅、抽帧、完整解码；另加人工内容审核。

添加素材前先展示本次检查范围和待处理文件，不让使用者误以为“上传”已经发生。素材错误保存在库中便于修正；缺失 / 坏文件无法导入时列逐项失败。

### 9.2 参数规则

|项目|程序规则|不能自动处理时的建议|
|---|---|---|
|镜号 / 分组|字母数字起始，后续字母数字下划线短横线，≤64；禁系统保留名|改用 A01-01 / EP01 等安全编号|
|提示词|非空，≤12000 字符计数|精简到本镜内容，用标题 / JSON 字段定位|
|时长|4—12 秒整数|用户或 AI 拆分动作；不硬截长剧情|
|种子|可空或 0—2147483647 安全整数|清空或填写合法值|
|图片单文件|<15,000,000 字节；可导入≤150,000,000，但超请求限制标问题|等比优化或外部图像工具|
|图像格式|PNG / JPEG / WebP|本地转格式；原件保留|
|图像尺寸|宽、高均 256—5760px|等比缩放及必要补边|
|图像宽高比|0.4—2.5|补边，不能拉伸主体|
|参考数量|图≤5、声≤3；连续前镜画面占一张图|减少引用、明确每张用途|
|声音总时长|2—12.001 秒容差|用户给裁切范围；不自动猜对白边界|
|请求体|组合估算≤约48MB；编码后严格<50,000,000 字节|减少素材或缩小文件|
|图片 / 声音占位|编号从 1，须存在对应类型和顺序|调整引用或占位|

MB 在代码中使用十进制字节限制。文本“字”当前按 JS 字符串长度近似计数，不是 Unicode grapheme 数；emoji 等可能占两个 UTF-16 单位。不要在文档或 UI 把这类限制伪装成语言模型 token 限制。

### 9.3 生成模式组合

|模式|允许|禁止 / 必须满足|
|---|---|---|
|text|prompt、对白约束、seconds、aspect、seed|不得带参考素材、首尾帧、连续前镜|
|reference|images / audios / 前镜画面|至少一个参考或有效前镜；不得带 first_frame / last_frame|
|keyframe|first_frame / last_frame 图片|至少一帧；禁止声音与 continuityFrom|

字幕 / 水印 / 白底拼贴、试音误用等通过提示词约束降低概率，程序不能保证模型遵守。对白密度约每秒超过 5 个汉字时给警告；不自动删台词。

### 9.4 图片优化

常规：长边最多 2048；宽高至少 256；根据 0.4—2.5 比例补最少画布；等比 fit 绘制，背景 `#ece9e3`。不裁切主体、不非等比拉伸。极窄图先按长边限制缩放，再补短边，避免生成数万像素画布。

原路径 PNG / WebP 保留其格式，JPEG 使用质量参数 0.92；普通管理素材可输出 `_优化.jpg`。底层还支持竖屏参考 720×1280 画布，但不是独立批量艺术重构。优化后重新 `importAsset` 校验，保留 transform。合规派生版本可跳过，已有同一派生版复用。

### 9.5 声音裁切

用户输入开始 / 结束秒数，满足 start≥0、end>start、end≤原时长容差、区间≤12。Web Audio 以 48kHz 解码，合成单声道 16 位 PCM；源路径 WAV 可直接保留 WAV，MP3/M4A/AAC/OGG/FLAC 再经 FFmpeg 转回真实对应编码。同名不等于原音质 / 声道完全不变，应听审。

普通管理声音另存带时间范围的 WAV。批量图片优化不自动裁切声音，列为 skipped；没有声音边界语义识别，也没有批量音色修复。

## 10. 清单解析、字段优先级与素材匹配

### 10.1 格式识别

先 trim / Unicode NFC / BOM 处理。以 `[` / `{` 起始按 JSON 解析：数组或 `{shots:[...]}`。否则在表头检测六种分隔符：逗号、tab、分号、竖线、中文逗号、中文分号；需要至少两个可识别列，最高分并列时报分隔符歧义。其余按纯文本独立分隔行拆段。

纯文本支持独立一行的两个及以上短横线、三个及以上等号 / 星号 / 下划线。CSV 每行一镜，不需要 `---`。不允许按 CSV 内普通标点随意拆剧情。

CSV parser 保留引号内换行和分隔符，`""` 表示字段内双引号；非空表头且规范名不得重复；每行列数必须与表头一致，错误包含源行号。未知列只作说明，在预览中列出，不把审核备注 / 历史试音当实际素材。

### 10.2 字段映射

|规范字段|主要中文 / 英文别名|说明|
|---|---|---|
|id|镜号、镜头编号、id|没有则默认前缀-01 等|
|episode|分集、分组、集名、episode|中文原集名可按本批出现顺序映射 EP01…|
|prompt|AgnesAI实际提示词、prompt、提示词、画面动作、画面与动作、画面描述|按列别名优先顺序选非空值|
|promptFile|prompt_file / path / ref、提示词文件 / 路径 / 引用、画面引用|非空文件列优先替换整个 prompt|
|dialogueFile|dialogue_file / ref、对白文件、台词文件、对白引用|替换对白字段|
|seconds|seconds、秒数、时长秒、时长|空则批量默认|
|aspect|aspect_ratio、aspect、画面比例、比例|空则批量默认|
|mode|mode、生成模式、生成方式|文字 / 参考 / 首尾帧映射为规范值|
|dialogue|dialogue、对白、指定对白、台词|明确空值保留为空|
|seed|seed、随机种子|转换数字后校验|
|files|assetIds、files、素材、参考素材、参考文件、素材编号、素材路径|主素材列，优先于图 / 声分列|
|images|images、image_paths、参考图、图片路径、图像路径、当前图像引用、当前图像候选引用|无 files 列时使用|
|audio|audio、audio_paths、参考声音、声音路径、音频路径、声音参考|同上|
|first / last|first_frame / 首帧、last_frame / 尾帧|精确图片引用|
|continuity|continuity_from、衔接镜号|必须引用此前任务|

字段规范化忽略大小写、空白、下划线和部分括号。历史五视图 / 审核说明等未识别列不会自动进入请求，即使里面存在可访问路径。

### 10.3 空值与默认参数

清单显式参数优先于本批默认，批量默认独立于单段。files 列存在时优先，空值 / `无` / `none` / `null` 表示明确无参考，选择 text 而不是拿共用素材填回。完全没有素材列才使用批量共用选择。首尾帧可决定缺省 keyframe；显式 mode 最终仍须通过组合校验。

中文分组自动 EP 映射仅在本批有效。跨批需要统一分组时应明确 EP ID，避免两份清单各自映射 EP01 后不小心混组。

### 10.4 素材引用

支持 `C01=../图片/角色.png`，后镜可复用 C01；多项用 `|`、分号、中文分号、换行或字符串数组。匹配优先精确 UUID，再当前源目录相对路径，再文件名 / alias / 唯一编号前缀。多个候选时报错，不能自动拿第一张。

反斜线规范化为 `/`；每个 `..` 必须留在已授权根目录。拒绝绝对盘符、URL、根路径、非法字符、过长路径。主目录索引最多 64 层、20000 文件，跳过 `.git`；索引只定位，不先读取全部媒体。

导出展开后的 JSON 中的媒体路径仍相对原 CSV 目录；使用者重新导入时应放在相同相对位置或调整路径。平台没有自动改写源文件的功能。

## 11. 递归文件读取与按类型替换

### 11.1 支持语法

|写法|效果|
|---|---|
|prompt_file=`../提示词/动作.md#开场`|用所选正文替换 prompt|
|prompt=`../提示词/动作.md#开场`|整个字段是明确文件路径时展开|
|`{{file:../风格.txt}}` / `{{引用:...}}`|正文内插入所选文件内容|
|`@file(../风格.txt)`|同上|
|`[风格](../提示词.md#标题)`|Markdown 文件链接展开|
|`![角色](../图片/角色.png)`|图片加入参考列表，文本写入对应 Picture 占位|
|`[声音](../声音/对白.wav)`|声音加入参考，写入 Audio 占位|
|`{"$ref":"其他.json#/shots/0/prompt"}`|JSON 引用与字段定位|
|files=`../素材目录.json`|按素材清单上下文读取，不把路径表原文塞入 prompt|

正文内普通自然语言保持文本。只有明确语法和有限“引用 / 见文件”形式解析；不对一句“风格像上次那个版本”猜文件。不执行文档内代码、shell、JS、HTML或任何所谓系统指令。

### 11.2 类型与定位

- TXT：全文，可继续含引用；不支持标题片段。
- Markdown：按唯一标题或当前镜号标题，取标题后的同级 / 更高级标题之间内容；代码 fence 内标题不用于章节定位。
- JSON：`#/字段/子字段` 指针、顶层字段或当前镜号；支持 `shots` / 数组按镜号；对象需明确 prompt / dialogue 字段或精确 pointer。
- CSV / TSV 文本：按当前镜号取对应行；重复 / 缺镜号报错。
- 素材 JSON：files / assets 数组、编号→路径对象、`{id,path}` 数组、`$ref`。
- 素材 CSV：编号 / 路径表，按素材表头检测分隔符；`#C01` 可只选一项。
- 图片 / 声音：读取定位，不当文字；首尾帧的嵌套目录须最终只得一张图。
- PDF / DOCX / XLSX / HTML / YAML 等：不进行内容展开，建议先转 TXT / MD / JSON / CSV。

每层相对路径的基准是**该层文件所在目录**，不是始终以源 CSV 为基准。最终媒体重新表达为相对原 CSV 的路径，规范路径去重；Picture 和 Audio 分别从 1 编号，引用发现顺序稳定。

### 11.3 递归执行算法

```text
解析主清单，并预收集编号定义
对每镜：
  建立媒体引用列表、占位标记、来源记录和替换记录
  先展开明确素材清单，再处理 prompt / dialogue
  对每个引用：
    基于当前文件归一化路径，在授权索引中唯一定位
    若是媒体，登记 / 去重并返回类型占位标记
    若是文本，检查路径+片段是否在当前调用链
    检查深度、数量、字节和操作预算
    从本轮缓存读取或实际读字节并计算哈希、解码
    按文件类型及上下文选择正文 / 行 / 字段
    将所选内容继续递归展开
  最后把暂存标记换为 <Picture n> / <Audio n>
  保存本镜已展开文本、素材路径、来源链和哈希
任一镜失败：保留错误供预览，但整批禁止入队
```

缓存和调用链必须分离：同一个文件在不同镜头正常复用，不是循环。循环身份为规范路径 + 片段，另有深度限制阻止变化片段绕过无限递归。

### 11.4 实际预算

|预算|当前值|
|---|---:|
|递归层数|12|
|不同文本文件数|500|
|单文本文件字节|2,000,000|
|已读取文本字节总计|10,000,000|
|每个展开文本字段长度|12000 JS 字符计数|
|解析操作计数|20000|
|展开行累计大小|10,000,000 JSON 字符长度近似|

最后一项当前用 `JSON.stringify(row).length` 计数，严格来说不等于 UTF-8 字节；后续可统一为字节计数。超过预算提示拆批 / 选片段，不悄悄截断。

引用文本支持 UTF-8、带 BOM 的 UTF-16LE / BE；UTF-8 解码失败尝试 GB18030 并提示核对。主清单直接导入当前使用 `File.text()`，建议统一 UTF-8，不能把嵌套引用的编码回退能力自动当主清单编码保证。

### 11.5 预览与输入快照

页面展示读取文件数、替换数、before / after、来源链、编码、哈希。展开完成后才允许下载展开 JSON。入队前重新读取文本并比对哈希；清单编辑使缓存失效；变化则要求重新展开。入队后 prompt / dialogue 固定为确认的文本快照，不再根据磁盘变化重写。

图片 / 声音在实际创建请求时再读源文件并核对哈希。文本来源记录写入 job、attempt.snapshot 和过程 MD；旧版本的输入证据不因当前文件优化而回写。

### 11.6 可复用的递归示例

```text
项目/
  分镜/第一集.csv
  提示词/动作.md
  提示词/风格.txt
  图片/小熊.png
  声音/环境.wav
```

```csv
镜号,分组,时长秒,提示词文件,对白
A01-01,EP01,8,../提示词/动作.md#开场,
```

`提示词/动作.md`：

```markdown
# 开场
{{file:风格.txt}}
小熊抬头看向远处的灯火。
![角色](../图片/小熊.png)
[环境](../声音/环境.wav)

# 下一镜
这里不进入开场。
```

风格.txt 可以继续含本地引用。只有上述图片、声音被定位导入；源目录中没有被引用的媒体不会全部上传。

## 12. 生成队列、状态机与不重复计费

### 12.1 Job 状态定义

|状态|界面含义|后续方向 / 操作|
|---|---|---|
|draft|素材待检查|预留标签；当前表单通常校验后直接入 pending|
|invalid|素材需处理|修正参数 / 素材，不发 POST|
|pending|审核通过 · 待提交|仅表示格式检查通过，等待用户启动队列|
|submitting|正在提交|检查点已保存，禁止另一收费提交|
|unknown|提交结果待核实|人工绑定原 video_id 或提供未创建依据|
|queued|服务端排队|沿原 video_id 查询，递增等待|
|generating|生成中|沿原 ID 查询|
|deferred|退避等待|仅明确未创建的限流 / 队列满允许重新提交|
|download|待下载|使用同一次尝试 URL 下载|
|checking|本地校验中|原始下载已保存，进行真实媒体检查|
|ready|已生成 · 待内容审核|技术通过，可预览 / 人工审 / 按组合成|
|approved|内容审核通过|使用者明确确认；整集仍待审|
|needs_redo|不合格待处理|技术致命问题或人工否定；先判断是否需重下载|
|failed|生成失败|服务商已确认失败，或明确创建拒绝|
|blocked|需处理后继续|权限 / 认证 / 缺链接 / 下载 / 本地检查等阻碍|

素材操作另有 success / warning / duplicate / skipped / error，不能与 Job 状态混用。

```mermaid
stateDiagram-v2
  [*] --> pending: 输入格式通过
  pending --> invalid: 提交前输入失效
  pending --> submitting: 保存检查点后提交
  submitting --> queued: 返回 video_id
  submitting --> deferred: 明确限流或队列满且未创建
  submitting --> failed: 明确拒绝
  submitting --> unknown: 超时或返回无 video_id
  deferred --> submitting: 等待后安全重试
  unknown --> queued: 人工找到并绑定原 video_id
  unknown --> pending: 已核实未创建并留证据
  queued --> generating: 开始生成
  queued --> download: 完成并返回 URL
  generating --> download: 完成并返回 URL
  queued --> failed: 确认远端失败
  generating --> failed: 确认远端失败
  download --> checking: 原始文件已保存
  checking --> ready: 技术通过
  checking --> needs_redo: 致命问题
  checking --> blocked: 未完成检查
  ready --> approved: 人工确认内容通过
  ready --> needs_redo: 人工标记问题
  needs_redo --> pending: 用户保存修订
  failed --> pending: 用户保存修订
```

图表示主要路径；查询 / 下载 / 权限失败还可进入 blocked，并由“继续原任务”“重新下载”“重新校验”等操作恢复。

### 12.2 调度原则

Runner 优先找 queued / generating / download / checking / blocked / deferred 现有任务，再找 pending 新任务。存在 submitting / unknown 时暂停整队核实；blocked 暂停并显示原因。一个任务生成、下载、检查处理完成后才继续下一镜。

“暂停新提交”允许当前已接受任务继续查询 / 下载 / 检查；到新任务边界停止。它不是云端取消按钮；当前没有实现取消收费任务的 API。

### 12.3 每次认证请求 ≥90 秒

Transport.api 在 `x-ai-auth-http` 锁内读取 `state/rate`：

```text
gapMs = max(90, settings.gap) × 1000
nextAt = max(last + gapMs, notBefore)
等到 nextAt
先保存 last = 当前时间
再发 POST 或 GET
```

连接测试 GET /v1/models、创建 POST、查询 GET 都计入。失败也占一个时间槽。刷新后读取上次时间，不能把新页面当成重新计时。媒体 CDN 下载不带认证，也不按认证 RPM 创建新槽。

退避 `min(3600,90×2^min(level,6))` 秒，notBefore 取已有值与新值较大者。第一次明确限流 level=1 通常 180 秒；长期排队在轮询次数达到阈值后递增；等待显示下次最早请求倒计时，不显示未经计算的完成 ETA。

### 12.4 创建前记录

请求实际构造及素材回读 / 哈希验证通过后，建立 Attempt：输入快照、原素材指纹、脱敏请求摘要、requestHash、衔接来源。然后 state=submitting、submittedAt 写入，`persist(true)` 确保磁盘 checkpoint 可写，才发 POST。

如果磁盘权限失败，应在 HTTP 之前中止。项目保存和媒体写入仍非跨存储事务；进程中断后要依据已有尝试保守恢复。

### 12.5 创建响应分类

|结果|处理|为何|
|---|---|---|
|JSON 中找到字符串 video_id|queued，立即持久化|已接受任务，有精确查询身份|
|只返回 task_id / id，无 video_id|unknown|task_id 不一定是视频查询 ID|
|429 + `rate_limit_exceeded`|deferred，延长等待|明确本次创建被拒绝|
|503 + `video_queue_full`|deferred|同上|
|400 / 401 / 403 / 422 明确拒绝|failed / resolved；401 / 403 暂停新提交|输入 / 权限问题，不把其余队列逐个收费尝试|
|其他 HTTP 错误 / 5xx / 非 JSON / 网络超时|unknown|可能已创建收费任务|

仅 HTTP 429 本身不够；要配合已识别代码。当前没有服务商幂等键协议支持，不能依靠“相同 prompt”认为重发免费或不重复。

### 12.6 查询与下载恢复

GET 失败保留 video_id。400 / 401 / 403 / 404 等需要处理时 blocked；普通网络错误退避继续查询。服务商 completed / success / succeeded 且有 URL 进入 download；完成但无 URL blocked。未知非终止状态保守显示 generating，不猜测已失败。

重新下载和手动导入不创建新视频。原始下载存在可复用 Blob 时 checking 恢复优先用它。需要重新拉取时 forceDownload。已知 ID 即使 UI 被误设 pending，也优先恢复 queued；未知未解决的 submittedAt 不能直接重做。

## 13. 输出校验、人工审核与交付含义

### 13.1 本地校验顺序

1. HTTPS 下载，累计大小限制 512,000,000 字节。
2. SHA-256 并保存 raw 文件和浏览器副本。
3. MP4 前 64 字节含 ftyp 的基础签名，大小≥1024；这只是第一层检查，不是容器形式证明。
4. 浏览器 video 元信息：实际 width、height、duration。
5. 请求时长 / 画幅 / 最低分辨率检查。
6. 五点 seek 抽帧并检查暗像素比例，保存 JPEG；另取结束附近的 PNG。
7. FFmpeg WASM 完整解码视频和可选音轨，获得 fullDecode、音轨、fps。
8. 保存 checks/report.json、clips 当前文件及 Attempt QA。
9. 技术通过后 ready，等待内容审核；失败 / 未完成保留原始文件与原因。

### 13.2 精确容差

|项目|当前判定|
|---|---|
|时长|>12.05 秒，或与计划差>0.25 秒为致命问题|
|比例|与该模型目标实际尺寸比例差>0.045 为致命问题|
|清晰度下限|宽高中较小者<680px 为明显低于720P的致命问题|
|暗画面|任一采样暗像素>90%只给警告|
|帧率|与24fps差>0.1fps给统一拼接警告|
|无音轨|单镜警告；当前按集拼接入口要求补音轨|
|完整解码|失败为致命；无法执行为 partial，不算通过|

这并不检查输出必须与每一个目标尺寸像素完全相等；当前是最低边长 + 比例容差。将来对不同模型应制定独立实际输出规格。

### 13.3 抽帧与“末帧”准确含义

五点比例为 6%、27%、50%、73%、97%，预览缩略图宽 240px。结束参考取浏览器视频 `duration−0.08` 附近，原视频尺寸 PNG。它来自实际当前视频，但 seek 不保证是编码序列的最后一帧；当前文案“真实末帧”应理解为真实视频结束附近画面。需要严格逐帧一致时后续可改用 FFmpeg 精确提取并保存帧时间。

暗画面可能是合理夜景，不能自动当坏片；五点抽帧也不能发现所有短暂闪帧、黑边、字幕或脸型漂移。没有内置语音识别、声音身份识别或黑边语义模型，不应写出“Whisper 已通过”等虚假记录。

### 13.4 人工审核项

|维度|使用者应检查|
|---|---|
|身份|人物脸型、服装、配色、怪物 / 道具正确|
|画面|比例填充、主体完整，无不期望字幕 / 水印 / 参考板标签|
|动作|本镜动作成立、没有重复前段、没有不合理突然切镜|
|对白|指定台词、发音、说话人、口型、无朗读动作说明|
|声音|环境声正确、试音未误作台词、音色一致、无意外人声|
|连续性|前镜结束状态、视线 / 方向 / 道具与本镜衔接|
|整集|节奏、剧情完整、镜间声音和转场，无不期望空隙|

只有使用者点击“确认内容审核通过”并确认完整观看 / 听审后，review=approved、state=approved。标记不合格需记录原因，review=rejected、needs_redo；不会立即自动发收费 POST。

### 13.5 成果与完成

一个 job 文件存在只是“有下载”；QA passed 表示“技术通过”；review approved 表示“单镜人工通过”。整集 MP4 和输入清单存在、解码和总时长通过后才是“有技术成片”；当前整集仍待人工审核。后台启动、队列入队或更新 MD 都不能当交付完成。

## 14. 版本、衔接与按集拼接

### 14.1 修订规则

用户在详情修订 prompt、dialogue、seconds、aspect、mode、参考和首尾帧，保存新版本为 pending。保留旧 Attempt、video_id、QA、文件和原因；`current=null`，队列由用户启动才创建新尝试。

原远端任务 unresolved / 未确认结束时禁止修订收费重做。unknown、submitting、queued、generating、deferred、download、checking 均不允许建立新的收费尝试。blocked 且没有 current 时需先恢复 / 核实，不能当成干净失败。

### 14.2 历史选择

已有历史视频可预览 / 设为当前。当前参数与历史 snapshot 时长 / 比例不一致时阻止直接选用。切历史后 review 重新 pending，后续镜头和成片不自动回滚；使用者须复核连续性。

当前 job.prompt 等字段不自动全面回滚为历史输入；历史 Attempt.snapshot 是该版本真实输入证据。未来改进历史 UI 应优先展示当前版本的 snapshot，避免用户误把当前待修文本当历史视频实际请求。

### 14.3 连续镜头

仅参考模式：给下一镜 images 最后一张追加前镜 `current.lastFrameKey` 对应的实际 PNG，写入运行约束；最多5张图仍适用。前镜必须 ready / approved 且有结束画面。Attempt.continuityInput 登记前镜视频 SHA、画面 SHA 和路径。

前镜换版不会自动免费修复后镜，也不会强制删除已有后镜；目前需使用者根据来源复核。后续可增加“依赖已失效”标记，见第 21 章。

### 14.4 拼接门槛与算法

同组所有镜 state 为 ready / approved，QA.technical=passed；同画幅；每镜音轨存在；输入总大小≤450,000,000 字节；按 jobs 顺序取 `current.blobKey`，核对哈希。

FFmpeg 为每个视频统一目标尺寸、等比 scale+pad、fps=24、SAR=1、时间戳从0；音频重采样48kHz、立体声、时间戳从0。concat 合并，H.264 libx264 / ultrafast / CRF20，AAC160k，MP4 faststart。当前没有可编辑转场、字幕、背景乐混音或时间线。

产物 duration 与计划 seconds 总和差≤0.5 秒；再次完整解码 passed 后保存 `episodes/EPxx_vN.mp4` 和 `_inputs.json`，登记版本、哈希、实际时长、输入指纹、review 说明。

### 14.5 旧成片失效检测

当前 UI 比较已有输入镜头哈希和 current 哈希，变化时显示“镜头已更新，需重拼”。它不是完整依赖审计：新增镜头、变更顺序 / 分组、删除或其他条件可能需要更完整比较。交付前应核对镜数、顺序、路径和输入清单，不能只凭未出现提示就断言成片为最新。

## 15. 密钥、安全与信任边界

### 15.1 普通模式

启动读取本机 `private/default-access.json`，成功自动启用，无需口令。用户可输入新的 sk- KEY，点“使用新密钥”；KEY 前后空格清理，格式按 `^sk-[A-Za-z0-9_-]{12,}$` 检查，成功后清空输入框。新 KEY 仅会话内存，刷新后回到本机默认或重新输入。

“密钥已启用”不是“接口认证通过 / 有余额 / 生成可用”。连接测试只请求模型列表，计入90秒间隔，不创建视频。

### 15.2 本机免口令封装

格式 `x-ai-local-default-v1`，openingKey 为32随机字节，iv为12字节，cipher为AES-GCM密文，均Base64。由于开启材料也在本机配置中，完整文件持有者可以恢复 KEY。它避免明文落盘，但不是公开网页隐藏共享密钥的方案。

整个 private 目录由 Git 忽略并留在本机；Pages 发布版不带私人默认 KEY，访客填自己的 KEY。不能把密文加开启材料同时公开后声称密钥安全。

### 15.3 高级保险箱

用户主动保存：`x-ai-vault-v1`，PBKDF2-SHA256 / 310000 次，16字节 salt，AES-256-GCM / 12字节 iv，口令至少12位；口令不保存也不发给 AgnesAI。解锁接受 iterations 100000—1000000 的受支持记录。

旧本机保险箱 `private/default-vault.json`；其口令由 Windows DPAPI 放在 `%LOCALAPPDATA%\X-AI\default-vault-password.dpapi`。取口令脚本只供同一 Windows 用户高级操作，不是正常使用步骤。忘记自行设定口令时应重新输入 KEY，不能凭空恢复。

导入为候选来源，解密成功才覆盖浏览器加密副本；输错口令保持之前活动密钥。高级模式每次打开设置默认收起；停止当前 KEY、备份 / 导入 / 删除和高级连接参数都在里面。

### 15.4 请求与内容安全

- 认证请求固定上游 ORIGINS；拒绝认证重定向，credentials=omit。
- CDN 下载只允许无内嵌凭据 HTTPS，不带 API Authorization。
- 本机连接器配对码在会话内存，重启更换；固定页面 Origin。
- UI 文本经 escapeHTML / textContent；文档、CSV、引用文件是数据，不执行代码。
- 项目恢复校验 path 不含绝对盘符、`..` 等；控制媒体 / task 字段及单在途任务。
- redact 去掉敏感命名字段、sk-字符串和完整 Data URI；这是程序规则，不是对所有任意格式机密的通用 DLP。
- CSP 限定脚本 self、WASM、媒体 blob / data / HTTPS、连接 self / HTTPS / 本机4174；没有第三方分析脚本。

用户提示词、路径、来源和服务商 URL 可以包含私人信息，项目 JSON / MD 也是私有制作文件。当前输出文件没有应用层加密，不应把“KEY 已保护”理解为所有素材 / 日志也已加密。

## 16. 错误反馈与二次操作

### 16.1 显示结构

先显示一句短原因，紧邻相关位置；详情保留原接口响应或逐项结果。能修复的问题提供明确动作，不只给“未知错误”。普通 toast 最长约7秒；设置弹窗固定反馈；状态阻碍保存在 job.error，不依赖短 toast 长期可见。

|情况|短说明方向|动作|
|---|---|---|
|无 KEY|请启用默认或填写自己的密钥|连接与密钥|
|目录权限失效|请重新授权本地文件夹|重新授权 / 选择原目录|
|已有 references|检测到已有文件，正在备份 / 已备份数量|查看备份位置|
|路径缺失 / 多候选|列镜号、路径 / 编号和原因|修正清单、选共同上级目录、重新读取|
|文本源已变化|预览已失效，需要重新展开|读取引用并展开|
|单图不合规|尺寸 / 格式 / 比例具体问题|优化、全图查看、下载|
|声音过长|实际总秒数超限|手工指定裁切 / 减少参考|
|批量部分坏文件|逐项失败，其他已保存|停止、继续剩余、重试失败、导出记录|
|429 / 队列满明确拒绝|退避等待，下一请求最早时间|暂停新提交、继续|
|POST 不明|可能已创建，必须核实|绑定 video_id、已核实未创建并填依据|
|GET 网络错误|原编号保留|继续查询原任务|
|认证失败|当前请求失败，已暂停新提交|更换 KEY、连接测试、恢复原任务|
|下载失败|可重试下载，无需新生成|重新下载、源视频、手动导入|
|解码失败 / partial|检查未通过，原文件已保留|重新下载、重新深度校验|
|艺术问题|显示用户记录的原因|标记不合格、修订、导出 AI 复核提示词|
|拼接超量 / 无音轨|不能按当前输入合成|分组、补音轨、外部FFmpeg|

### 16.2 批量素材控制

素材窗口先显示计划，随后当前文件、处理阶段、计数、progress、结果分类。停止在当前项保存后生效；继续剩余和重试失败是本页面的一轮恢复，关闭页面后没有持久化的素材批量任务恢复承诺。已保存 Asset 可以从项目 / 浏览器恢复。

素材库全选 / 选待优化 / 清空为批量勾选；“用于当前分镜”或“批量共用素材”决定参考选择，二者不能混淆。导入全库不意味着全部加入某镜。

### 16.3 ZIP 与下载措辞

ZIP 使用 store、不重编码媒体、UTF-8、CRC32，同名（不分大小写）加序号；最多500MB / 65535条目，加素材清单和哈希。打包内有进度，取消在安全点结束；原文件字节不改。

浏览器 a.download 只发起下载请求，不能证明用户系统已保存。文案应为“ZIP 已准备 / 已请求下载”，不能在没有 File System write 证据时宣称磁盘保存成功。视频当前提供单镜和逐集下载；没有统一“批量所有视频 ZIP”入口，后续可扩展但不冒充现有功能。

## 17. AgnesAI 接口协议与可选连接器

### 17.1 当前接入基准

以下是项目当前已采用的接口规则，来源为既有实操和源码；不是此次重新从服务商核实的最新版规格。上线 / 新模型接入前应再核对服务商文档、账户权限和余额。

|项目|当前值|
|---|---|
|主要 Origin|https://api.agnes-ai.cn|
|备用已知 Origin|https://apihub.agnes-ai.com|
|模型 ID|agnes-video-2.5-flash|
|创建|POST /v1/videos|
|查询|GET /agnesapi?video_id=…&model_name=agnes-video-2.5-flash|
|连接检查|GET /v1/models|
|Authorization|Bearer + 会话 KEY|
|请求内容|JSON，size=720P，n=1，seconds 为字符串|
|认证超时|浏览器180秒；连接器上游120秒|
|媒体下载|HTTPS，浏览器180秒；连接器上游150秒|

默认不因一个 Origin 失败自动切换另一个并重新 POST。用户改连接设置须等当前任务处理结束，保持原 video_id 和调用记录。

### 17.2 创建请求示例

```json
{
  "model": "agnes-video-2.5-flash",
  "seconds": "8",
  "mode": "reference",
  "size": "720P",
  "aspect_ratio": "9:16",
  "n": 1,
  "seed": 42,
  "images": ["data:image/png;base64,<此处为真实图片编码，不是字面占位>"],
  "audios": ["data:audio/wav;base64,<此处为真实声音编码，不是字面占位>"],
  "prompt": "以<Picture 1>作为角色参考，小熊抬头。\n\n【X-AI运行约束】\n……"
}
```

未设置 seed 时不发送。reference 使用 images / audios；keyframe 用 first_frame / last_frame；text 不带素材字段。dialogue 不作为独立 API JSON 参数发送，而是在 requestPrompt 中变成明确对白约束。记录脱敏请求时 Data URI 替换为“本地二进制素材，未导出”，实际 HTTP 使用完整编码。

### 17.3 本地素材为什么不需要图床

平台从 File / Blob 真实读取图片和声音，校验后用 FileReader.readAsDataURL 编码到请求体。这个接入路径已由此前实操采用，解决本地文件不能直接当公网 HTTPS 路径的限制。不是所有未来模型都支持同样输入方式，接入时必须确认。

当前不实现通用文件上传到公共图床，不需要在 GitHub Pages 放私人素材。媒体内容在创建时仍随请求发送给 AgnesAI，Data URI 并不意味着服务商没有收到文件。

### 17.4 画幅规格映射

|比例|当前 DIMENSIONS，用于比例 / 拼接基准|
|---|---|
|9:16|720×1280|
|16:9|1280×704|
|1:1|720×720|
|4:3|960×720|
|3:4|720×960|
|21:9|1680×720|

16:9 实操常见实际高度704，不写成严格1280×720。其他维度是当前程序基准，不应直接推断服务商每次必定输出完全同像素。

### 17.5 可选本机连接器

`tools/connector.py` 使用 Python 标准库，只监听127.0.0.1:4174。默认允许 localhost / 127.0.0.1:4173；Pages 用户增加 `--origin https://用户名.github.io`，不含仓库路径。随机配对 token 在控制台显示，用户填高级连接设置；重启更新。

允许路由仅：POST /api/v1/videos，GET /api/agnesapi，GET /api/v1/models，POST /media。Origin 精确允许、配对码恒定时间比较、固定上游、请求体≤50MB、API 响应≤4MB；认证请求拒绝重定向。媒体 URL 要公网 HTTPS / 默认443，并检查 DNS 结果不能为内网，重定向逐次复核。

连接器不记录请求头 / 体，不保存 KEY。认证节流文件 `%LOCALAPPDATA%\X-AI\connector-rate.json` 只存 Authorization 哈希和上次时间，在单进程锁内至少90秒。哈希仍属于本机运行数据，不放进公开仓库。多个独立连接器进程并非统一跨进程事务，应只运行一个实例。

连接器失败不会重发 POST，只返回保守502提示。浏览器是否允许 HTTPS 页面访问回环地址还受其本地网络策略影响；连接器不是对所有浏览器 CORS 问题的无条件保证。

## 18. 运行、发布、迁移与准备信息

### 18.1 本机运行

开发目标：Windows、Python3.10+、桌面 Chrome / Edge。双击 `启动X-AI.cmd`，或运行：

```powershell
cd PRIVACY-REDACTED\REDACTED-DIR
python tools/serve.py
```

访问 `http://127.0.0.1:4173/`。服务只提供静态文件，不处理生成。不能直接用 file:// 打开 index.html；模块、WebCrypto、Web Locks 和文件权限需安全上下文。

可选连接器：

```powershell
python tools/connector.py
# GitHub Pages 用户替换为自己的实际源：
python tools/connector.py --origin https://YOUR_NAME.github.io
```

### 18.2 发布者需要准备

GitHub账号、仓库名、本人Git提交姓名 / 邮箱、登录方式；可用Pages仓库；可选域名和DNS；用户自己的Agnes账户 / 配额。没有须写入GitHub Actions / Pages的API Secret，本平台无构建部署后端。

本地仓库位于 main，当前已存在本地提交 `a0d7499 Add X-AI local video creation studio`。此前使用说明中的“尚无首次提交”属于旧状态。本文未检查远端或Pages部署结果，发布由用户自己完成。

```powershell
cd PRIVACY-REDACTED\REDACTED-DIR
git status
git ls-files private .local
# 上一条应无私人文件输出
git config user.name "YOUR_NAME"
git config user.email "YOUR_GITHUB_EMAIL"
git add docs README.md tools/build-design-doc.mjs
git commit -m "Document X-AI detailed design"
git remote add origin https://github.com/YOUR_NAME/x-ai.git
git push -u origin main
```

在仓库 Settings → Pages 选择 Deploy from a branch、main、/(root)。部署后 `https://YOUR_NAME.github.io/x-ai/`。有 `.nojekyll`，模块 / WASM 使用相对路径。源码、licenses、vendor/source应保留；不要用浏览器拖拽上传整个私人工作目录。约32MB WASM 超过GitHub网页单文件上传限制，推荐Git push，不改成Git LFS指针文件。

上述是已有项目说明的发布流程，此文档整理未代为登录、提交、push或公开发布。若 GitHub 后续界面或规则变化，按其实际设置核对。

### 18.3 使用者需要准备

支持文件目录API的浏览器、足够磁盘 / 内存、能调用Flash的KEY和配额、镜号 / 分组、4—12秒分镜、明确提示词 / 对白、合规图片 / 声音。最初先验证一个4秒文字任务，再图 / 声参考，再较小批次；不要和外部生产脚本同时消耗同一账户的RPM。

### 18.4 换电脑 / 换域名

浏览器本地数据按 Origin 分开：端口、域名、浏览器变化不自动迁移。复制完整输出目录，打开新页面，选择旧目录，恢复项目并核对所有视频 / 原始下载 / 历史 / 抽帧 / 末帧 / 成片，重新启用密钥。

原路径素材未复制到输出目录，因此还需复制源素材目录并重新授权。只复制project.json、只复制输出目录却漏源素材都不能保证恢复。当前恢复对原素材可能需先从批量源目录授权并补入缓存，再恢复项目；不能绕过哈希匹配。

### 18.5 第三方组件

应用原创源码为MIT，`@ffmpeg/ffmpeg`0.12.15为MIT，单线程`@ffmpeg/core`0.12.10按随仓库的GPL许可说明分发，含libx264等组件。`THIRD_PARTY.md`、license、vendor/source源码与构建来源应随再分发保留。此文档说明仓库材料，不提供法律意见或改写第三方授权。

## 19. 性能、资源与可靠性设计

### 19.1 资源预算汇总

|环节|预算 / 做法|
|---|---|
|单批 / 恢复项目镜数|≤1000|
|主清单|≤10MB|
|手动导入项目JSON|≤20MB|
|目录索引|≤20000文件、≤64层|
|嵌套文本|12层、500文件、2MB每个、合计10MB|
|单素材导入|≤150MB；API要求<15MB|
|认证请求体|<50MB，Base64增加约1/3|
|媒体下载|≤512MB|
|素材ZIP|≤500MB|
|单次拼接输入|≤450MB|
|FFmpeg|单Worker、串行；约32MB WASM首次加载|
|队列渲染|默认前60条，“显示更多”每次增加60|
|批量预览|前20镜|
|图片库|lazy decoding，全图默认contain|

这些是应用防护预算，不保证接近上限时每台设备仍流畅。Base64、Blob、IndexedDB、FFmpeg虚拟文件和raw / clips物理副本可同时占用内存 / 磁盘。超大项目按集处理，必要时导出清单交桌面工具。

### 19.2 释放与排队

Object URL由页面缓存并在项目切换时撤销；下载链接延迟释放。FFmpeg任务finally删除虚拟文件并移除日志 / 进度监听；引擎保留复用。素材批量逐项执行并yield，避免持续阻塞；ZIP CRC读取过程中让出主线程。

### 19.3 可靠性的实际边界

网络POST超时不能证明未创建；local write和IndexedDB没有跨介质事务；浏览器存储配额可能不足；外部文件变化会令File句柄失效；浏览器自动睡眠 / 冻结不能保证后台调度。项目当前没有Service Worker生产执行、后台桌面守护进程或服务器持续队列。

恢复优先证据，不盲目“清空缓存再试”。保存磁盘和浏览器副本能提高可恢复性，不是所有断电情况的绝对保证。需要工程级长期无人值守时，可另设计本机常驻执行器，但应明确脱离纯静态页面能力范围。

## 20. 实际验证记录与可复现方法

### 20.1 已有证据

|检查|记录结果|证据类别|
|---|---|---|
|core / batch / references规则|最近联合41项通过|自动规则测试|
|batch-browser|最近10组通过|隔离浏览器、合成素材 / 目录、无收费API|
|references-browser|6组通过|真实OPFS / IndexedDB，递归来源与变化检查|
|asset-library-browser|8组通过|导入 / 进度 / 全图 / 派生 / ZIP|
|browser生产流程|17组通过|模拟生成接口、真实WASM解码 / 拼接 / 恢复|
|credentials-browser|已记录10组普通密钥 / 布局检查|合成KEY与模拟模型列表|
|连接器单元|已记录4项通过|来源 / token / 路由 / 内网URL|
|媒体合成测试|两镜合计计划8秒，容器8.021秒，完整解码passed|本地真实引擎和合成MP4|
|历史真实认证|2026-09-30 02:37北京时间，GET /v1/models HTTP200，含Flash|当时真实网络 / CORS / KEY；不代表收费创建|
|最近侧栏 / 模型界面|1500、1000、390px，单段 / 批量，无溢出 / 重叠|一次性视觉 / 几何检查，已留截图|

上述为仓库已记录的过去验证，此次写文档没有重跑所有业务测试。平台开发阶段没有额外实际收费生成；长任务经验来自此前工程，不把合成样片当模型成片。完整测试背景见 `docs/验证记录.md`。

### 20.2 核心复现命令

```powershell
cd PRIVACY-REDACTED\REDACTED-DIR
node --test tests/core.test.mjs tests/batch.test.mjs tests/references.test.mjs
python -m unittest discover -s tests -p "test_*.py"

# 已启动4173本地服务，且安装Playwright / Edge后：
node tests/batch-browser.mjs
node tests/references-browser.mjs
node tests/asset-library-browser.mjs
node tests/credentials-browser.mjs
```

生产浏览器回归还需要测试仓库子路径服务：

```powershell
# 在单独终端保持运行：
python tools/serve.py --port 4175 --prefix /x-ai/
# 再在测试终端运行：
node tests/browser.mjs
```

Playwright无法从项目常规模块解析时，按测试脚本支持的PLAYWRIGHT_PATH指向已安装包；不把某台电脑的私有运行库绝对路径写成访客必需条件。测试输出test-results被Git忽略。

### 20.3 关键回归场景

未知POST再次点击继续只提交一次；缺video_id不采用task_id；GET失败保留原ID；90秒槽在请求前保存；401暂停后续；源图优化保留原哈希和真实PNG/M4A编码；既有references备份失败不覆盖；递归循环 / 缺失整批拒绝；预览后文本变化阻止旧内容入队；单段空required不阻止批量；当前版本路径拼接；换目录 / 完整历史恢复；手机无横向溢出。

### 20.4 何时重跑什么

- 仅颜色 / 文案 /可逆排版：实际浏览器查看相关宽度、可读性和操作；不用新增镜像实现的永久测试。
- 清单 /引用 /素材映射：规则测试 + batch / references浏览器。
- 密钥 /网络 /队列：credentials + core + browser + connector，并模拟未知提交。
- 媒体 /拼接 /恢复：真实WASM、完整解码、文件哈希和输入清单。
- 新模型 /真实API变化：先服务商规格与小额可控冒烟，再逐路径回归；不能用模拟通过代替真实兼容。

## 21. 现有限制、已识别欠缺与改进次序

本章是交接时需要知道的事实，不表示文档整理已修复这些问题。

|事项|当前状态|建议|
|---|---|---|
|多模型路由|select只有一个，Runner用常量|实施provider / model能力配置与任务快照后再加选项|
|前镜换版依赖|记录continuityInput，但不自动严格标后镜失效|建立依赖图和明确待复核状态|
|旧整集判定|主要比较原inputs中的SHA|完整比较顺序、数量、分组、路径、参数和SHA|
|严格末帧|浏览器seek结束前0.08秒附近|必要时FFmpeg逐帧提取并登记PTS|
|恢复协议|基本校验，无完整schema迁移框架|增加版本迁移、未知字段和深层值检查|
|跨磁盘事务|IndexedDB + 多文件写，非原子|事务journal / prepare-commit标记、可恢复写入计划|
|原路径跨电脑恢复|必须重新源目录授权 / 缓存|独立“定位原素材”向导，逐源根映射和哈希核对|
|素材处理轮次|页面内可继续，轮次未完整持久化|可选Operation记录，不覆盖已完成Asset|
|草稿|单段 / 批量切换保留本页，刷新不保证|独立Draft存储，明确恢复提示|
|自动语义审核|未内置视觉 / ASR|可选插件式审片，证据与人工结论独立|
|大项目下载|素材ZIP有批量，视频逐镜 / 集|可选按组视频ZIP / 目录导出并核对|
|日志膨胀|events /attempts在project内|分片事件和归档，保持恢复可读|
|主要CSS|历史覆盖累积、部分压缩长行|按组件 /断点重整，先保持截图回归|
|主清单旧编码|File.text默认为UTF-8|复用严格编码识别，并明示回退|
|展开总限量|JSON字符串计数近似MB|统一UTF-8字节预算|
|历史文本展示|详情读job.prompt，不全面同步选中历史snapshot|历史 /当前输入对照，防误读|
|配对与多设备|同源锁和单连接器进程|需要跨设备时另建明确账户级调度，不隐式并发|

建议先处理会影响计费、恢复或当前文件真实性的事项，再做长项目操作、性能及语义辅助。视觉优化不得以降低可读性或掩盖状态换取密度。

## 22. 后续多平台 / 多模型扩展设计

### 22.1 能力配置（未实现）

为每个模型增加ModelSpec，避免Flash常量散落：providerId、modelId、displayName、version、size选项、seconds最小 /最大 /步长、aspect实际尺寸、输入模式、图片 /声音数量、字节 /时长限制、DataURI /URL输入能力、authGap、poll策略、创建 /查询适配器、输出QA策略。

示意配置：

```json
{
  "providerId": "agnesai",
  "modelId": "agnes-video-2.5-flash",
  "displayName": "Agnes Video 2.5 Flash",
  "version": "2.5",
  "resolutions": ["720P"],
  "duration": {"min": 4, "max": 12, "step": 1},
  "inputModes": ["text", "reference", "keyframe"],
  "reference": {"imagesMax": 5, "audiosMax": 3, "fileBytesMaxExclusive": 15000000},
  "minAuthenticatedGapSeconds": 90,
  "adapterId": "agnes-flash-v1"
}
```

这不是当前可直接导入的运行配置。新增字段要迁移现行Project/Job/Attempt，不应直接混入当前schema而不验证。

### 22.2 逐任务冻结

用户选模型后，UI更新限制；入队时冻结 provider / model / size /能力版本；提交Attempt保存该快照；恢复 /轮询使用Attempt原模型，不用页面当前选择。已有Flash任务不能因用户选择另一项而改model_name查询或重新创建。

能力与验证联动：时长下拉、素材预检、请求体、提示词约束、结果尺寸、拼接组兼容均按所选模型更新。明确费用和不兼容输入，转换需要新派生素材，不改原件。

### 22.3 适配接口

建议职责：validateInput(job,assets)、buildPayload(job,assets)、create(payload)、extractSubmission(response)、poll(attempt)、normalizeStatus(response)、extractMedia(response)、validateOutput(file,expectation)。Transport保留统一认证节流、超时、脱敏和下载凭据隔离。

模型特有错误不能套用Flash的“429代表未创建”等猜测。只有适配器明确证实拒绝创建的代码才重试；未提供幂等保证就继续保守unknown。

### 22.4 新接入验收

先核对官方参数 /真实账户；小规模真实文字、图声、首尾帧、查询、下载；模拟未知提交、认证、限流；跨域 /连接器；输出时长 /像素 /音轨 /解码；恢复原任务；模型切换不影响历史。完成以后才在下拉启用该选项。

## 23. 非功能与验收标准

### 23.1 可用性

普通KEY替换一输入一按钮；高级默认折叠；说明≥14px；状态不只靠颜色；目录与实际数可见；所有耗时操作有阶段或数量；危险重做和历史选择表达后果。弹窗错误不能被遮罩挡住。

### 23.2 数据完整性

原路径文件哈希不变，源CSV不改；既有references备份回读；优化版真实编码及映射一致；请求输入与记录一致；当前视频路径 /SHA与拼接输入对应；所有换版保留历史；恢复缺失或哈希错误必须停止。

### 23.3 计费与队列

任意认证请求间隔≥90秒；最多一个在途生成；unknown不重发；查询错误保留ID；用户未启动队列不创建；修订只准备pending；401不把整批全部提交；暂停新提交不宣称云端已取消。

### 23.4 交付核对表

|级别|必须核对|
|---|---|
|单镜技术|实际MP4、哈希、时长、比例、解码、current路径|
|单镜内容|完整观看 /听审、具体问题记录、review|
|整集技术|镜数 /顺序 /分组、当前输入路径 /哈希、成片总时长、解码|
|整集内容|节奏、连续性、声音 /对白、整片观看|
|可迁移|project、raw、clips、checks、episodes和原路径素材均可读 /再授权|
|公开发布|无KEY /private /生产素材 /测试私密记录、资源相对路径、licenses|

当前应用可以自动完成部分核对，但没有统一最终全项目audit按钮。开发 /交付仍应据实际证据核对，不能用文件数量或MD更新替代审计。

## 24. 实操经验转化为设计决策

|经验 /坑|成因|设计决定|
|---|---|---|
|查询超时后重新POST重复消费|误把查询网络错误当生成不存在|video_id优先、unknown核实、查询原编号|
|RPM只限制创建仍触发限流|GET /测试也占认证请求|共用时间槽，所有认证≥90秒|
|单镜太长 /动作拥挤|生成接口最长12秒且动作表达受限|校验拒绝，用户 /AI拆镜，不自动硬截|
|本地图片不能直接当URL|服务商读不到用户盘符|真实文件DataURI路径，不额外图床|
|复制references破坏清单路径|原引用变文件名 /目录|原件不拷贝，优化才另存，运行映射|
|扩展名保留但编码变了|只改文件名没有实际转码|PNG /M4A等真实编码核对|
|旧五视图 /试音误入生成|把所有备注列当素材|字段白名单，历史备注只显示不提交|
|长横 /竖图卡片裁头脚|CSS容器最小内容尺寸与cover|明确容器+contain+宽卡+全图|
|输入几十文件无反馈|把异步多步骤叫一次上传|预检计划、阶段 /数量、停止继续|
|错误toast被modal遮罩挡住|top layer高于普通z-index|弹窗内固定反馈|
|单段必填字段阻止批量|只隐藏没disabled|独立fieldset，同步hidden+disabled|
|参考板白底 /标签进视频|模型复制版式|运行约束+真实看图，不能技术检查冒充视觉审|
|动作说明被念对白|提示词混合叙事 /台词|dialogue独立、只说指定对白约束|
|ASR近音字 /幻觉|识别不是最终艺术证据|当前不伪造ASR，将来保留识别置信与人工结论|
|前镜换版后后镜引用旧末帧|按文件名猜版本|current哈希与continuityInput来源|
|整集把历史版本拼回去|未使用当前登记路径|只从current输入，保存实际inputs|
|只复制JSON无法恢复|媒体与原路径来源未迁移|全文件恢复校验，源根重新授权|
|默认KEY加密却公开开启材料|纯前端免口令与秘密共享矛盾|private仅本机，发布使用者填KEY|

## 25. 给接手开发者 / AI 的执行说明

### 25.1 接手顺序

先读AGENTS、本文、README、验证记录，再读待改模块。确认工作目录为D盘X-AI，不改此前Z盘视频生产、人物、分镜或工作进程。先检查Git状态和服务进程，保存现有变化，不清空仓库或用户目录。

### 25.2 不可省略的决策

1. 用户最新界面优先：普通密钥简单、模式操作区分开、目录可知、字号可读、书本图标、两行标语、同行署名+下一行艺术字。
2. 任何计费生成须是用户已授权操作。开发验证默认合成KEY /素材 /模拟接口，不为了演示悄悄发真实POST。
3. 不把KEY、口令、配对码写日志 /Git /文档；无需读取private文件来做无关UI修改。
4. preserve last Attempt / video_id；不要clear manifest /尝试列表去“解决”unknown。
5. 先改源数据 /真实接口行为，再更新派生记录和说明；历史版本不回写冒充当前。
6. 明确实现 /验证 /后续设计，不能只做选项或说明就称已完成后端功能。
7. 常规小改只验证实际风险；涉及状态 /输入 /恢复须跑相应回归；通过记录必须真实。
8. 模型能力、运行限制和输出校验必须同步；不要改UI最长秒数却仍发不兼容请求。
9. 原素材直接引用，优化映射按哈希 /ID；不能仅因为同名就替换所有文件。
10. 用户负责Git身份 /推送 /Pages发布；未授权不代为公开或更改身份。

### 25.3 交接工作输出

每次说明具体问题、修改结果、实际验证及剩余边界；同步README /专题docs /验证记录。文档以2026-10-01当前基线为准，后续修改日期和版本写文档，不恢复产品已否定的生成日期块。

若扩展schema，准备旧样本迁移、输入证据保留和恢复测试；若变更请求，准备unknown /原ID恢复；若改文件命名，准备旧current /历史 /sources迁移，不能让原清单失效。

## 26. 附录：用例、术语与文件索引

### 26.1 验收用例模板

|编号|输入 /操作|预期结果|
|---|---|---|
|A01|新4秒text、无素材|合法入pending，未启动无POST|
|A02|13秒 /小数秒|明确拒绝，不截为12秒|
|A03|带6张参考图|素材可在库中，但分镜组合拒绝|
|A04|CSV千行、引号内换行 /分隔符|逐行镜头，剧情字段不误拆；列数错误报行号|
|A05|source.csv→JSON→MD→TXT并带图声|每层目录基准正确，图声去重、占位匹配、源哈希登记|
|A06|同文件正常复用 vs真正循环|复用缓存，循环整批拒绝并给引用链|
|A07|预览后外部文本改变|旧展开结果不能入队|
|A08|源图不合比例，优化|原哈希不变，派生同名格式真实、映射指向新图|
|A09|已有references，备份写失败|不覆盖原文件，不继续目录写入|
|A10|提交超时 /无video_id|unknown，重复开始不重复POST|
|A11|GET暂时失败|保留ID，退避查询，无新收费任务|
|A12|同task重新下载字节变化|另存下载序号，旧字节和QA保留|
|A13|视频时长 /分辨率 /解码不符|技术致命问题，保留原始文件，提示先重下载|
|A14|合法夜景大面积黑|仅暗画面警告，用户判断|
|A15|历史版设当前再拼接|当前路径 /哈希写inputs，审核重置|
|A16|第二同源工作台|不加载并改写项目，显示锁提示|
|A17|390px / modal错误|无横向溢出，错误在可见弹窗，完整规格可读|
|A18|新模型接入|真实能力、快照、原模型查询、输出QA全部联动|

以上是可复用验收用例，不全部表示此次文档制作又执行了一次；已有执行记录以第20章及验证记录为准。

### 26.2 术语

|术语|含义|
|---|---|
|Origin|协议+域名+端口，不含仓库路径；决定权限 /存储隔离|
|Data URI|把本地字节编码为data: MIME;base64字符串随JSON发送|
|SHA-256|内容指纹；验证相同字节，不是质量评分或加密存储|
|video_id|查询视频的服务商身份；与task_id不能猜着互换|
|Attempt|一次创建尝试及其输入 /输出 /错误证据|
|current|当前剪辑采用的明确视频记录|
|derivedFrom|派生资产指向原件|
|effectiveAssetId|原素材当前可用优化版|
|unknown|提交可能接受但缺确切结果，必须核实|
|partial|深度校验未确认通过，不是failed也不是passed|
|OPFS|浏览器私有文件系统，测试用于隔离素材；不等于用户输出目录|
|IndexedDB|本网站浏览器数据库，保存工作副本 /二进制 /句柄|
|WASM|本地运行的WebAssembly媒体引擎|

### 26.3 阅读与源码索引

|文件|内容|
|---|---|
|README.md|运行、使用边界、发布方法|
|AGENTS.md|当前项目协作 /用户最终界面约定|
|docs/密钥使用说明.md|普通KEY、高级保险箱、私有配置|
|docs/素材操作说明.md|预检、进度、全图、批量优化 /ZIP|
|docs/批量清单与路径引用.md|语法、路径、递归示例|
|docs/实现与实操经验.md|实现决策和历史纠错|
|docs/验证记录.md|过去实际执行的证据、模拟与真实区分|
|docs/部署与准备清单.md|用户应准备什么 /发布检查|
|THIRD_PARTY.md / LICENSE|原创与第三方许可 /来源|
|src/|实际业务源代码，协议与字段最终需对照实现|
|tests/|规则、浏览器、连接器与合成媒体验证|
|vendor/|随站点分发的媒体引擎和许可 /源码材料|

### 26.4 本文维护约定

本文为总体设计基线，专题说明为操作细节，验证记录为执行证据。三者发生冲突时先核对用户最新要求和当前源码，再修正文档。保留历史验证日期，不把以前通过改成新版本已通过。HTML阅读版从本文件生成，不单独修改正文；文档不记录真实KEY、配对码或用户私人生成素材。

HTML阅读版的生成工具为 `tools/build-design-doc.mjs`。只在维护文档时需要 Node 与 marked 开发工具；应用运行和已经生成的HTML不需要它们。

```powershell
cd PRIVACY-REDACTED\REDACTED-DIR
# 本机已有marked包时，可直接指定其模块路径：
$env:MARKED_PATH = 'C:\你的开发工具路径\node_modules\marked\lib\marked.esm.js'
node tools/build-design-doc.mjs
```

也可以在独立开发工具目录安装marked，并让MARKED_PATH指向该包，避免把文档构建依赖混入生产静态文件。生成器用解析器输出表格和带锚点目录，将三张Mermaid图转为无脚本的流程概览，并保留可展开的完整Mermaid源码。文档其他代码块只显示，不执行。
