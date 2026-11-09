# 🐋 DeepMoYu · 鲸鱼摸鱼

DeepMoYu 是一个 DSH（DeepSeek Harness）插件：**让一只鲸鱼娘自己逛 B站**。她不是替你打开网页的工具——她会自己搜片、读字幕原文、判断值不值得看，在拿到你的授权后**自己发评论、发动态、回私信**，把看过的东西写进日报，需要时还能做成视频。角色提示词、记忆和对话内工具仅在「🐟 鲸鱼摸鱼模式」生效。

一句话概括：**把 DeepSeek 这类模型接进 B站当一个真正的up主级用户**——自主浏览、自主互动、有自己的口味和记性，而不是一个只会念摘要的机器人。

本项目基于 `dsh-bili-scroll` 0.1.19（MIT）开发，保留原作者和 vendored 代码署名。当前源码版本为 **2.4.2**；源码版本、npm 发布和市场收录分别管理，详见 [更新记录](CHANGELOG.md) 与 [发布说明](docs/RELEASING.md)。

**更新**：点鲸鱼 → 设置 → 账号与环境 → 「检查更新」。registry 安装（从 npm 或插件市场装的）可以直接点「升级到最新版」，升级后完全重启 DSH 生效。目录联接/源码检出这类本地安装不会被自动覆盖——按钮会锁定并说明手动升级办法，因为运行数据在插件家目录，源码改动应当由你自己用 git 管理。

## 她会自己做什么

| 自主行为 | 说明 |
| --- | --- |
| 自己找片 | 按关注、分区排行、全站热门、关键词自己搜，不靠你一条条点 |
| 自己看片 | 读 AI 字幕原文再判断，不拿标题、简介、弹幕当看过；没字幕就说没看到 |
| 自己发评论 | 挑中视频后写评论，可配表情包；获批后带 `@` 找你 |
| 自己发动态 | 把今日所得发成动态，有每日上限 |
| 自己回私信 | 按收件人与消息资格回复，不越界 |
| 自己写日报 | 每天一份选片笔记：为什么挑、看到了什么；可做成视频 |
| 自己记事 | 学习要人工批准才生效，`soul.md` 记心情与自我认识，越刷越像她 |

所有发送行为**默认关闭**，由你逐项授权；授权后仍受发送前审核、永久判重、节奏冷却和平台额度约束。她可以多看、少说、甚至这一轮不发言。

## 功能

- **运行方式**：当前会话自主浏览、新开会话浏览、后台任务、每日定时及跨午夜连续时段。会话和后台分别保存模型、时长与预算。
- **互动与投递**：视频评论、楼层回复、动态、私信和成果投递分别授权；发送前审核、永久判重、节奏、冷却与额度状态共同约束发送。
- **记忆与素材**：学习队列、角色记忆、语气与口味记录，以及内置和收集表情。待审素材在批准前不进入发送或学习参考。
- **视频工作室**：可见会话编排分镜与旁白，本地生成视频、双比例封面、时间线和校验回执；保留角色逐句口型。只生成本地文件，不自动投稿。
- **记录与用量**：活动、事件、真实 token 账本、七天回顾与恢复入口。未知用量显示为未计量，不估算为零。
- **偏好与设置**：桌宠显示、陪伴频率、安静时段、专注模式、减少动效、账号及运行环境。

工作台默认打开「运行方式」，首屏显示 **新开会话刷** 和 **后台刷**。单击或右键桌宠打开菜单，双击新开浏览会话；隐藏后可通过右下角圆点恢复。

![工作台界面演示](assets/screenshots/workspace.png)

截图使用合成演示数据，不代表真实账号、用量或平台发送结果。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| DSH | 包声明范围为 `>=0.1.7-rc.1`；完整功能还需下述宿主能力 |
| Node.js | 22 或更高；桌面版一般使用自带运行时 |
| Python | 支持 3.11–3.13，或可用的 `uv`；主依赖安装由工作台触发 |
| 视频依赖 | 主依赖中的 Pillow、`edge-tts`、`imageio-ffmpeg`；中文画面还需可用的中文字体 |
| 模型 | 用户已在 DSH 配置且有权使用的模型；插件不提供模型账号或额度 |

对话内工具要求可靠的 `agent.ctx.tools` 会话作用域。视频制作还需要模型选择、目标续轮和终态回传能力。缺少能力时界面会显示原因并禁用对应入口，不将工具注册到普通会话，也不自动更换模型。不同宿主版本的验证范围见 [审查记录](docs/RELEASE_AUDIT.md)。

应安装到已经正常工作的 Desktop/Web profile，并由宿主提供 `webServer` 与 `agentPresets`。纯 base/headless profile 不直接承载该桌宠工作台；后台浏览由插件另行创建受控 headless 任务。

默认配音使用在线语音服务；GPT-SoVITS 为用户自行配置的可选本地环境。插件不附带音色模型或参考音频。依赖下载、平台访问、模型和在线配音都需要相应网络连接。

## 安装

### 从 npm 安装正式版

```sh
npm view dsh-deepmoyu version
dsh plugin --profile web add dsh-deepmoyu
```

第一条查询实际已发布版本，第二条安装该版本；本地打包不会更新 npm。将 `web` 替换为实际使用的 profile。安装后完全退出并重新打开 DSH。

### 从源码安装

```sh
git clone https://github.com/pyyxzi/dsh-deepmoyu.git
cd dsh-deepmoyu
npm ci --omit=dev
```

然后将源码目录的**绝对路径**传给 DSH，例如：

```sh
dsh plugin --profile web add "link:<插件目录绝对路径>"
```

DSH 会管理 profile 的依赖和 bundle 列表，不需要手动创建 junction 或修改其他插件。Windows 路径中有空格或中文时保留引号。详细步骤、离线包安装、迁移与卸载见 [部署指南](docs/DEPLOYMENT.md)。

> 正在维护的本地链接安装应直接更新源码；不要用 registry 安装覆盖本地分叉。修改 JS 后必须重启 DSH，刷新页面不会清除宿主模块缓存。

## 首次配置

点桌宠 → **工作台 → 偏好与设置 → 账号与环境**：

1. 安装主依赖：创建插件独立 Python 环境；本地字幕转写为可选依赖。
2. 扫码登录：使用 B站客户端完成登录。
3. 检查连接：验证登录状态与搜索读取。

主依赖和自动下载仅在明确操作后执行，没有 npm 安装期脚本。系统没有 Python/uv 时会尝试下载并验证 uv；失败原因显示在安装日志中。

**评论、回复、私信和动态发送默认关闭。** 阅读不需要开启发送；想让**她自己发言**，到「互动与投递」逐项打开：`autoComment`（发评论，可 @ 你）、`autoMoment`（发动态，受每日上限约束）、`replyToComments`（回楼层）、`autoReplyDm`（回私信）。自动收集和自动配图也有各自的开关，不能代替发送授权。

## 使用

| 任务 | 入口与行为 |
| --- | --- |
| 让她自己刷（当前会话） | 切到鲸鱼摸鱼模式，明确要求开始；选择模式本身不启动循环。之后她会自己找片、自己判断、自己决定说不说话 |
| 让她自己刷（新会话） | 菜单或运行页「新开会话刷」；继承来源工作区及实际权限 |
| 后台与定时 | 运行页设置独立参数；连续时段可跨午夜，手动停止后暂停至本时段结束；重启 DSH 仍会按时段自动接上 |
| 停止与恢复 | 运行状态或运行页控制；只影响选中的插件任务 |
| 让她发言 | 「互动与投递」逐项开授权；获批后仍经过发送前审核、判重、节奏和平台额度 |
| 发送审核 | 「互动与投递」逐条批准/拒绝；批准后仍经过权限、判重、节奏和平台限制 |
| 学习与记忆 | 「记忆与素材 → 学习与记忆」筛选、审核、撤销或按版本移除记忆 |
| 表情管理 | 「记忆与素材 → 表情收藏」上传、链接收集与人工审核；内置图库只读 |
| 日志与账本 | 「记录与用量」查看活动、原始事件、账本及数据回顾 |
| 制作视频 | 「视频工作室」选择日期、形式、时长与模型，点击「新开会话制作」 |

### 用量与调度

后台预算是提示词软预算，不是逐 token 的硬上限；实际 usage 用于记账，墙钟截止时间由独立定时器控制。缺失或部分 usage 如实显示。模型与时长的草稿保存用于下一次启动，不修改已经运行的任务。

后台连续时段的配置会持久保存。重启后调度器重新检查时段与暂停状态；失败、风控、缺少模型或环境仍可能阻止启动。不要把自动恢复理解为外部服务始终可用。

### 视频制作

制作会话先获取冻结的公开素材快照，再编排开场、旁白、观点对照、步骤卡与结尾。预览检查后提交完整渲染；字幕来源、日期和逐字引语与素材快照核对。渲染接受后会话等待终态，完成或失败回传原制作会话。停止只取消对应制作任务。

成片必须通过实际帧数、帧率、音轨解码、非静音、逐句时间线和时长检查后，才进入成片列表。失败保留计划与日志；重做使用独立目录。宿主退出中断的任务会显示恢复状态，不伪装为成功。

### 模式与记忆隔离

发送开关、收件人、审核门禁与运行预算通过工作台人工配置；模型的配置工具只能调整安全偏好，`force` 参数不构成授权。关闭发送权限后，批准审核也不能绕过该权限。

切出鲸鱼摸鱼模式后撤销角色工具，旧工具句柄也重新检查作用域；本插件拥有的残留摸鱼目标会暂停。普通会话、其他模型设置及其他目标不被修改。已经写入聊天历史的内容不会自动删除。

学习与记忆是参考数据，不授予发送权限；撤销批准从后续提示词中移除相应参考。外部字幕、评论和私信不能覆盖工具权限。发送结果未知时先核对，不自动重复发送。

## 数据与隐私

运行数据保存在 `<DSH_HOME>/bili-duty/`，与源码目录分开；已配置的记录镜像另存在工作区根目录。备份可能含有效凭证，不应公开上传。

凭证在本机保存，但账号请求仍会向 B站携带授权信息；模型会处理获准读取的任务上下文，默认在线配音也会发送旁白。插件没有独立遥测上传服务。完整数据流与删除方式见 [数据与隐私](docs/PRIVACY.md)，问题报告方式见 [SECURITY.md](SECURITY.md)。

## 开发与验证

源码开发安装完整依赖：

```sh
npm ci
npm test
npm run test:python
npm run test:ui
npm run test:browser
npm run release:check
```

Python 媒体测试需要 Python 3.11–3.13 与已锁定的依赖；图像库使用修复已知漏洞的 Pillow 13。浏览器测试需要 Chrome/Chromium。可用 `PYTHON` 和 `CHROME_PATH` 指定可执行文件。npm 运行包仅提供 `npm run check`，其余开发命令从完整源码运行。测试范围见 [功能矩阵](docs/TEST_MATRIX.md)，环境与未覆盖的外部条件见 [审查记录](docs/RELEASE_AUDIT.md)；完整贡献步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布

```sh
npm run release:build
npm run release:smoke
```

构建生成 `release/dsh-deepmoyu-2.4.2.tgz`、源码 ZIP、归档验证报告与 `SHA256SUMS`。构建会验证实际文件内容，不包含运行凭证、日志、缓存或 node_modules；源码包包含测试与发布文档。发布前先完成全部验收，见 [发布指南](docs/RELEASING.md)。

插件市场需要单独提交目录条目，npm 发布不会自动收录。可提交文件为 [marketplace/pyyxzi__dsh-deepmoyu.yml](marketplace/pyyxzi__dsh-deepmoyu.yml)，截图由仓库根的 `screenshots.json` 声明。外部仓库主题、条目审核、账号权限和 npm 认证需在发布时核对。

## 常见问题

- **界面或图库返回 404**：完全退出并重开 DSH，确认当前 profile 加载了正确源码版本；然后手动刷新对应面板。
- **没有角色工具或不能新开会话**：检查诊断中的 `toolScope` 和宿主能力提示，不要通过全局注册绕过隔离。
- **评论报 12014**：平台拒绝该评论通道发送；插件保留退避，其他通道仍按各自权限与限制执行。
- **二维码过期或登录失败**：重新生成二维码并检查网络与设备时间；不要把二维码或凭证发到公开 Issue。
- **视频无声或失败**：查看该制作任务日志、音视频校验和依赖状态；在线配音失败不能算制作完成。
- **安装下载失败**：查看安装日志；可自行安装 Python/uv，或使用部署指南中的手动路径配置。不要关闭完整性验证。

## 目录

```text
index.js / client.js       宿主入口与桌宠工作台
cordis.patch.yml           插件 bundle 声明
presets/                  隔离角色模式
lib/                      调度、发送、记忆、计量与视频模块
vendor/bilibili-mcp/       内置 Python MCP 与共享发送守卫
assets/                   角色图片与界面演示截图
scripts/                  可移植测试与发布工具
selfcheck.mjs / tests/     自检与回归测试
docs/ / marketplace/      部署、隐私、发布记录及市场条目
```

## 许可证与致谢

代码使用 MIT，保留 [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 和 [AGI_Ananas / bilibili-mcp](https://github.com/adoresever/bilibili-mcp) 的许可证与署名。见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 与 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

图片、参考音频和模型文件的授权与代码许可分别处理，见 [素材说明](docs/ASSETS.md)。项目不附带 B站或模型服务账号；发布内容和素材应满足对应平台规则及授权范围。

---

## 鲸鱼书评线 fork 说明（xiaofeng930415 fork，2026-11-06）

本 fork 用于 `xiaofeng930415/xianyu-publisher` 的「鲸鱼娘 × B站书源门自动书评」（规格见该仓 `docs/spec-whale-bili-book-comment.md`）。

- **基线**：上游 `v2.6.0`；工作分支 `whale-book-comment`；fork tag `whale-v2.6.0-1`（每个上游版本打一次）。
- **改造**（按主题拆 commit，可单独回贡）：`bili_book_comment` 工具 + 书评模式官腔闸 warn + `book:`/`up:` 判重键 + 后台白名单收窄 + `prompts/book-review.md` + `vendor/book-gate/`（仓库逐字副本）。
- **上游文件补丁 1（2026-11-08，T6 真机发现）**：`vendor/bilibili-mcp/mcp_server.py` 的 `bili_video_info` 增补
  `owner`（含 mid/name）与平铺 `owner_mid`，只增字段、不动既有字段——上游只输出 `author` 名字，
  宿主书评线的 `up:<uid>` 判重与 ledger `mid` 即使不上 ⇒ uid 预检永远 fail-closed。上游回贡候选。
- **安装**：`cd ~/.dsh/profiles/desktop && pnpm add "link:$HOME/gitstore/dsh-deepmoyu"`，然后**完全退出 App 重开**。
- **升级**：`git fetch upstream --tags` → `git merge v2.X.Y` → `npm ci && npm test && node selfcheck.mjs` → 完全重启 → 打新 fork tag。
- **回滚**：`git checkout whale-v2.6.0-1` + 完全重启；彻底回滚＝`pnpm add dsh-deepmoyu@2.6.0`。
- **不改**上游 `prompts/duty.md`；改 `.py` 必须改本仓源码（`ensureHomeFiles` 会覆盖运行目录副本）。

### 运行边界（T6）：每日上限 · 止损矩阵 · 首 3 条人工批准

规格 §9.2/§9.4/§9.5 的宿主实现（判定在 `lib/whale-bounds.mjs`，形状在 `lib/whale-ledger.mjs`）：

- **每日上限**：观察期 3 条/天、稳定期 5 条/天；达限**拒绝并记 `skipped:daily-cap`**
  （§9.2 只要求拒绝+留痕，不停批次；停批次归下面的止损矩阵）。上限按 ledger 里
  「当天 `sent:true` 的行」硬数，不看模型记性。
- **首 3 条人工批准**（§9.3）：书评已成功发送数 < 3 时，即使「发送前审核」开关关着也强制进预览队列
  （不会直发）；第 4 条起回到开关语义。
- **止损矩阵**：L0（12014 / render-error，含发送前的 gate render-error）停当日、L1（风控码
  -352/-412/-509/-799、连续 3 次非 pace 发送失败、send-unknown）停 24h、L2（DOM 核验 1 条 hidden）停 3 天、
  L3（hidden ≥2 或 ≥已发 20%、同书/同 UP 二次 hidden）停 7 天；触发即写 ledger 并停批次（后台终止子进程、
  会话暂停 goal）。已有未清除的停损期间，新一轮直接拒绝开跑。
  L2/L3 的信号来自 V2 DOM 抽样（v2_dom 槽），生产者见下一节（T5c/T7，2026-11-08 接线）。
- **降速 1 条/天**（不停跑）：连续 2 次 send-unknown 或最近 2 条已发的 V1 全判 miss/invisible。
  接口 miss 只当「待复核」，不单独判不可见（§9.5）。
- **人工动作走文件**（模型无权改）：`<DSH_HOME>/bili-duty/whale-bounds.json`（默认 `~/.dsh`，DSH_HOME 可改）
  ```json
  { "phase": "observation", "dailyCap": null, "stopAck": "", "speedAck": "", "note": "" }
  ```
  - 升档：`"phase": "stable"`（或直接给 `"dailyCap": 5`）；
  - 停损恢复：停满 + 人工核验后把 `"stopAck"` 写成当前 ISO 时间（必须晚于停损起点）；
    恢复首日只发 1 条，那条 24h 可见才回正常档；
  - 降速恢复：`"speedAck"` 写成当前 ISO 时间。
  文件缺失/损坏按观察期默认值处理（不会把插件卡死）。
- **留痕**：`events[]` 追加 `skipped:daily-cap`、`skipped:stop-loss`、`stop-loss:L0..L3`、`stop-cleared`、
  `speed-down`、`speed-restored`、`recovery-ok`、`alert:no-hook`、`alert:tone-warn` 等；
  `/status` 的 `whaleBounds` 字段直接给出现读数（T7 真机验收核对用）。

### V2 DOM 抽样核验（T5c/T7，2026-11-08）：生产者接线

规格 §10.4 的权威可见性判据（接口只作辅助）。实现分两层，都在 `lib/whale-dom.mjs`：

- **判定/调度（纯函数，可离线单测）**：`judgeDomResult` 把探针回包判成 `visible / hidden / unknown`；
  `pickV2Targets` 决定这一轮核谁——① V1 判 miss/invisible 的行优先；② 否则每天随机 1 条（上限 3 条/天）。
  已经核过的行（有 `v2_dom`）不重核；没真正发出的行不核。
- **浏览器壳（`probeDom`）**：专用**临时** profile 的 headless Chrome（`mkdtemp` 的 user-data-dir，用完整个删掉），
  cookie 从 `bili_credential.json` 注入 `SESSDATA / bili_jct / buvid3 / dedeuserid` 四个——
  **绝不复用日常浏览器登录态**（与旧引流线 ego-browser 继承用户登录的做法隔离）。三步法：打开视频页 →
  滚到 `#end`「没有更多评论」（证明完整加载）→ 穿 `bili-comments` shadow DOM 按 `data-user-profile-id`
  认领并核对正文（钩子前 12 字）。
  - 判据：完整加载 + 找到 = `visible`；完整加载 + 未找到 = `hidden`；未完整加载 / 页面打不开 / 没跑起来 = `unknown`。
  - Chrome 路径：默认找 macOS Chrome/Chromium 常见位置，可用 `WHALE_CHROME_PATH` 指定。
- **接线**：`sweepWhaleV1` 收尾（批起/批止 sweep）→ `whaleV2Check` 到期才真起浏览器 → 判完写
  `posted[].v2_dom` + `events[] v2-dom:<status>` → **立刻 `whaleBoundsTick`**（`hidden` 是 L2/L3 的唯一信号，
  写完不判 = 停不下来）。手动口：`POST /api/bili-duty/whale/v2`（body 可带 `{id}` 指定 ledger 行；
  不带就按上面的触发口径挑）。`/status` 的 `whaleV2` 字段给出最近一条已核结果。
- **实测（2026-11-08，T7）**：对首条真实书评（`BV1Mx476YEnf` / rpid `323305833488`）跑通，
  13 秒出结论 `visible`（`dom:found`，正文含钩子前 12 字，threads=1、`#end`=「没有更多评论」）。

### 后台接力调度（#1725，2026-11-09）：重试 + 槽释放恢复 + 审核轮让位

起因：pet 后台轮「提前收工自动接力」原实现是 `setTimeout 2.5s` 后调一次 `runDuty`，且**不看返回值**——
`runDuty` 在槽被占时正常返回 `{ started:false, busy:true }`（不抛错），接力于是静默放弃；
学习审核轮（`learn-review:auto`，`automationTick` 每 15 秒一跳）可能刚好在接力定时的 2.5 秒里抢到同一个
headless 槽，抢到之后又没人把 pet 窗口拉回来 ⇒ 无人值守长窗口静默缩水（2026-11-08 实测两次：承诺
「剩余 84/88 分钟」后窗口直接结束，见 #1725）。

现在（判据在 `lib/bg-relay.mjs`，纯函数，7 例单测；`index.js` 只做 spawn 与日志）：

- **排接力先登记** `pendingRelay` ⇒ 学习审核 `auto` 看到它就**让位**（日志 `学习审核（auto）让位`），
  手动审核照旧（跑完槽释放钩子会把窗口接回来）。
- **被占就退避重试**：`runDuty` 回 `busy` ⇒ 5s / 15s / 30s 退避（封顶 30s），到 `deadline-2min` 才
  放弃并留痕（`接力被占（剩余约 N 分钟）⇒ N 秒后重试（第 k 次）` / `接力放弃（槽长期被占）`）。
- **槽释放即恢复**：任意后台子进程退出（`dutyDone` 之后）=> `resumePendingRelay`：有待接力窗口、
  槽已空、剩余 ≥2 分钟 ⇒ 立刻拉起（日志 `槽释放（后台轮退出）：待接力窗口还有约 N 分钟，立刻恢复`）。
- **不该恢复的情形**：手动停（`user`）/ 出错 / 停损（`whale-*`）⇒ 取消待接力；停损停批次与手动
  `/pet/stop` 同样清掉。
- **可观测**：`/status` 新增 `backgroundRelay`（`why` / `attempts` / `deadlineAt` / `remainingMs`）；
  日志关键词 `接力恢复` / `接力被占` / `接力放弃` / `槽释放` / `让位`。
- **回归**：`node --test tests/bg-relay.test.mjs`（7 例：首次 2.5s、重试 0s、5/15/30s 封顶、剩余不足即放弃、槽释放判据）。

### V1 补核巡检（#1743，2026-11-09）：重启后不再静默延后

V1（T+30min / T+24h，规格 §10.3）原本只靠**发送时挂的内存定时器**（`index.js` 发送成功分支里的 `setTimeout`），
App 重启就丢；兜底只有后台轮「批起/批止 sweep」——**没有后台轮启动就没人核**（2026-11-09 实测延后
7 小时 20 分：凌晨 01:22/01:28 发两条，直到 09:13 手动开 1 分钟空跑触发批起 sweep 才补上）。

现在：
- `sweepWhaleV1IfDue(trigger)`：只读 ledger 跑 `dueV1Checks(..., {max:4})`，**有到期才**真跑 sweep
  （不联网、不空转；当日志出现 `whale V1 补核（启动/巡检/manual）：到期 N 条` 即命中）；
- 插件启动后 8 秒补一次 + **每 60 秒轻量巡检**（只读一个小 JSON）⇒ 重启后最多 60 秒内补齐；
- `/status` 增 `whaleV1: { due }`（重启后应收敛到 0）；
- 手动口 `POST /api/bili-duty/whale/v1`（返回本次到期条数，sweep 异步跑）。
