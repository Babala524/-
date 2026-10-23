# 后端对接约定

## 自动模组更新与信箱（2026-10-22）

GET `/api/inbox` 返回最新 100 条通知、全局未读数及自动更新状态（enabled、intervalMinutes、lastCheck、nextCheck、error、checking、active）。通知含 id、created、kind、title、payload、read，payload 包含 modID、name、message、automatic 与 deferred。POST `/api/inbox/read` 接收 `{through:integer}`，只标记该序号及之前的消息，避免并发新消息被误读。

PUT `/api/workshop/auto-update` 接收 `{enabled:boolean}`，状态持久化，默认开启。POST `/api/workshop/auto-update/check` 返回持久化 taskID，允许暂停自动检查后手动检查并下载；有游戏或模组操作时返回 409。全部接口要求登录并执行同源校验。

后台每分钟调度，距上次检查至少 15 分钟才查询 Steam 最新元数据。仅比对可信本地安装记录与实时工坊版本；缓存或未知版本不自动下载。自动更新 stageOnly=true，即使游戏停止也只暂存，延用原 3 下载槽与共享发布锁，现有房间及模组选项不变。成功通知按任务去重，面板重启后从持久化任务补偿漏发；失败指数退避，同版本最多 3 次。

## 房间公告（2026-10-22）

房间保存和读取新增 `description`（单行，最多 256 字符）与 `announcement: {enabled:boolean,message:string,intervalMinutes:integer}`。游戏内公告最多 500 字符，支持换行，间隔 1～1440 分钟，旧房间默认关闭、空内容、30 分钟。房间介绍写入 `[NETWORK] cluster_description`；恢复存档按导入值替换，缺失时清空，不继承旧介绍。定时公告是面板配置，导入游戏原生存档不覆盖这一配置。

POST `/api/rooms/:id/announcement` 要求登录、房间可加锁且主世界正在运行，发送服务器已保存的消息，不接收任意 Lua。成功返回 `{data:{submitted:true}}`，仅表示控制台命令提交；停服或共享游戏更新中返回 409。定时任务每 15 秒检查一次，在主世界广播一次以避免分片重复，保存发送时间去重，失败退避 60 秒。

## 游戏更新

GET `/api/game/status` 要求登录，返回 `{installed,version,task}`，task 是最近一次安装或更新的持久化任务，可用于刷新后重连。POST `/api/game/update` 接受可选 `{validate:boolean}`，默认增量更新；`validate:true` 强制完整文件校验。POST `/api/game/install` 保留兼容，默认完整校验。全部房间世界关闭后才能执行，共享锁阻止其他游戏、存档和模组冲突操作。

状态响应额外包含 `buildID` 和 `update`。`update` 含 state（current/available/ahead/unknown/unavailable）、available（true/false/null）、installedBuild、latestBuild、checkedAt、attemptedAt、nextCheckAt、stale、error 和 source。通过 api.steamcmd.net 的 App 343050 public 分支元数据对比本地 appmanifest 构建号；不比较 version.txt 与 Steam build ID，不取测试分支。成功结果在后端缓存 15 分钟，并发请求合并；失败后一分钟退避，保留上次结果并标记 stale。浏览器登录后、回到页面时和可见期间每分钟读取缓存，网络检查不启动 SteamCMD、不触发停服或升级。

任务 result 在执行期间包含 phase、progress（当前阶段 0～100 或 null）、elapsedMs、downloadedBytes、totalBytes、bytesPerSecond（未知为 null）及最多 30 行 logs。下载字节按 SteamCMD 下载阶段输出采样，校验与写入阶段清零下载指标；阶段变化时百分比可重新计数。完成仅在 SteamCMD 明确成功（`fully installed` 或 `already up to date`）、退出码为零且游戏程序存在时返回 installed:true；已是最新版时额外返回 `upToDate:true`。失败保留 installation.log，不将旧二进制存在当作成功。

## 世界配置双模式（2026-10-21）

每层森林或洞穴均提供可视化和 Lua 代码两种编辑方式，共用该层的 levelData 字符串。代码输入立即更新内存配置；切换模式或世界保留原文。可视化修改只替换目标值，保留注释、自定义字段和模组静态参数。世界预设保存、应用同样保留完整原文。

代码编辑器提供行号、复制、静态校验和错误行列提示。单层最多 262144 字符，只接受返回静态表的 Lua，必须包含 overrides 表（允许为空）；不执行代码，不接受函数、变量或计算表达式。无效代码保留供修正，并阻止切换到可视化、保存房间或创建世界预设。完整配置通过现有房间保存接口提交，服务端再次校验后写入对应层的 leveldataoverride.lua。游戏运行中也可保存；重启后加载修改，地形生成参数仍只在生成新世界时生效。

双击 HTML 时只编辑浏览器草稿。通过新建的 Node.js 后端访问时，服务器注入 `backend-client.js`，提供 `window.featherPanelServices` 和当前房间 `window.featherPanelRoom = { id, directCode }`，保存按钮改为写入服务器配置。后端接口与 Docker 启动方式见 `backend/DEPLOY.md`；云服部署验证记录见 verification.json。下文草稿行为描述对应独立 HTML 预览模式。

## 工坊服务

以下三个方法均返回 Promise。前端接受直接返回对象，或包在 `{ data: ... }` 中的对象。方法失败时应 reject。

`searchWorkshop({ page, pageSize, searchType, searchText })` 返回 `{ rows, total }`。`searchType` 为 `text` 或 `id`。每行至少有字符串 `id`/`publishedfileid` 与 `name`/`title`。搜索结果不会自动加入房间，用户点击添加后才进入草稿。

`syncWorkshop({ roomID, ids })` 返回数组或 `{ rows }`，行结构同上，可带 `version`、`category`。前端只更新工坊元信息，并保留现有启用状态和参数；这个接口的成功不代表模组已经下载、安装或在游戏中启用。

`getModConfig({ roomID, worldID: 0, modID })` 返回 `{ fields, values }`。`fields` 每项为 `{ name, label, hover, default, options: [{ description, data }] }`。`data` 可以为字符串、数字或布尔值，前端保留类型。`values` 为以 `name` 为键的当前参数值对象。此版本配置以房间为单位，后续适配器可将启用状态与参数展开到各层世界。

这三个方法是 FeatherPanel 自己的后端服务协议。DMP 仅为实现参考，不作为外部连接对象。源码中的 `/mod/search`、`/mod/downloaded`、`/mod/setting/mod_config_struct`、`/mod/setting/mod_config_value` 等可作为后续开发自有后端的实现参考。下载与任务进度属于后续后端实现。

## 保存与默认参数

`roomData()` 返回当前表单完整内存数据，包括本次填写的 `password`。`exportRoomDraft()` 返回可持久化的草稿，不包含密码；`saveRoomDraft()` 将它写入 `localStorage` 的 `feather-room-settings-v3`。

草稿有 `name, maxPlayers, mode, pvp, pause, vote, worldCount, worlds, mods, automation`。`worlds` 每层含 `directory, type, port, levelData`。仅前 `worldCount` 层为当前启用层；后面的数据是撤回世界层数时保留的缓存，不应部署。`mods` 中的启用状态和参数也仅为待应用草稿。

`automation` 为 `{ backupTime: '06:00', autoBackup: true, startType: '32-bit' }`，备份时间按服务器时区解释。

`defaults` 指示 `tokenPolicy: 'dmp-default', portPolicy: 'dmp-default', masterIP: '127.0.0.1'`。它只是默认分配意图，不是实际令牌或已占用端口。后端必须基于已有房间和世界重新分配隐藏端口并检查冲突。前端不包含可用游戏令牌。

以后实现提交时需从 `roomData()` 读取密码；不要使用无密码的持久化导出替代完整提交。修改房间模式后，用户可在每层世界中明确应用对应预设，避免静默覆盖自定义配置。

## 新面板自己的模组服务

本页参考 DMP 的模组下载、添加、启停和参数配置功能，作为 FeatherPanel 自己的模块实现。这里不连接独立 DMP 面板，不需要 DMP 地址、账号或令牌。上文 DMP 路由只说明代码参考来源，不是本页的连接目标。

适配方法 getInstalledMods({ roomID }) 从 FeatherPanel 后端读取当前游戏服务器的安装列表。接受直接数组、{ rows } 或外层 { data: ... }。每行包含 id、name，可带 localSize、serverSize、file_url、config 和 configFields。ID 接受数字或数字字符串。完整列表读取成功后按 ID 去重并替换旧缓存，失败保留旧列表；不会自动启用模组，也不会将示例标为已安装。

列表缓存在 feather-installed-mods-v1，包含 roomID、syncedAt、mods，仅恢复对应房间的缓存。界面的“刷新已安装模组”读取新面板的后端，不访问 DMP。当前前端按 Workshop ID 管理；本地非工坊模组的独立标识扩展尚未实现。

模组下载调用 downloadMod({ roomID, id, file_url })。返回 downloaded: true 才表示下载完成，之后刷新安装列表；其他成功响应仅表示任务已提交。updateMod({ roomID, id }) 和 deleteMod({ roomID, id }) 对应更新与删除服务。只有返回 deleted: true 才会从安装列表中移除，后台任务已提交不等同于完成。删除不清除预设中的引用。

模组设置和已安装页的单个/批量启停修改当前房间草稿；保存草稿后，真实写入游戏由后续后端实现。参数结构与 getModConfig 的协议一致。更新、下载和删除目前都只有服务接口，未连接后端时不会伪造完成状态。

## 个人模组预设

预设保存在 feather-mod-presets-v1，为数组 [{ id, name, updatedAt, mods }]。每个模组保存 id、name、icon、config、configFields。新预设从当前面板的已安装列表选择；已有预设中的缺失项可保留以供之后补齐。

预设编辑中的参数与房间草稿隔离，点击保存才持久化；取消时提醒未保存修改。名称不得为空或与其他预设重复。列表支持将选中的模组加入新建或已有预设。

applyModPreset(id) 检查当前房间安装列表是否包含全部预设 ID；缺失时阻止应用。覆盖启用组合或已修改参数前确认，然后将组合和参数写入房间草稿，保留房间信息和世界配置。之后需保存房间草稿并由新面板后端部署，不自动重启游戏。

个人预设目前仅在同一浏览器中保留，跨设备共享需要后续账号级存储。预设不复制模组文件，也不保存房间密码或游戏令牌。

## 日志管理与存档管理

日志页调用 `window.featherPanelServices.getLogs({ roomID })`，每行包含 `type`（game/chat/system）、`time`、`world`、`message`。存档页调用 `getSaves({ roomID })`，每行包含 `name`、`world`、`time`、`size`（用于展示的大小文本）。两者接受直接数组、`{ rows }` 或外层 `{ data: ... }`，在当前结果上搜索和筛选；失败保留现有列表，尚无后端时显示未连接状态。存档页立即备份复用控制台现有入口，真实备份待后端接入。

快照页调用 `getSnapshots({ roomID })`，列表返回形式同上。每行包含 `id`、`name`、`worldID`、`world`、`day`（非负整数）、`time`、`size`（展示文本）。前端按世界与搜索词筛选；缺少 ID 的条目不能恢复。确认后调用 `restoreSnapshot({ roomID, snapshotID, worldID })`，返回 `{ restored: true }` 才显示完成；`{ taskID }` 仅显示请求已提交。可带外层 `data`。后端负责停止/恢复游戏、协调多世界进度一致性、校验快照归属以及执行恢复；前端不通过删除文件模拟恢复。切换房间会清空旧快照，旧请求或确认不得应用到新房间。

上传调用 `uploadSave({ roomID, file, name, onProgress })`，其中 `file` 是用户选择的原始浏览器 File，当前适配层用 application/octet-stream 发送原始文件流，名称与原文件名通过查询参数传递；`onProgress(percent)` 可选回报 0～100 的数值，未回报时显示不定进度。ZIP、TAR.GZ、TGZ 前端仅校验扩展名与非空，后端必须验证实际格式、存档结构、解压路径和资源限制。名称可选，空名称使用文件名。上传语义为校验并加入房间备份列表，保留当前游戏进度，不直接覆盖活动世界。成功返回 `{ uploaded: true }` 后刷新备份；`{ taskID }` 仅表示排队，未确认完成时不添加虚构列表项；响应可带 `data`。失败保留文件供重试，上传中禁止重复提交与关闭弹窗，文件不写入 localStorage。

当前 Docker 适配器已实现下载、更新、删除和配置保存。downloadMod/updateMod 支持 onProgress(taskState)，包含 state、result.progress（0～100 或 null）、result.message、result.stage、error。GET /api/workshop/downloads 返回最多 3 个并发任务及最近结果，带 modID、name 和 taskID，用于页面刷新恢复。POST /api/rooms/:id/mods/download 同一 ID 重用运行中的 taskID。新模组允许在游戏运行时下载，更新已有安装需关闭所有房间；旧版 ZIP 格式 legacy.bin 自动安全解包。任务完成后刷新已安装列表，列表返回 preview_url。

2026-10-20：POST /api/rooms/:id/control 的 start/restart 接受 mods 数组（id、name、enabled、config）。服务端先验证安装，再在同一房间锁内协调停止、持久化所有世界和启动；返回 modsSaved、enabledMods、restarted。PUT 房间时若只改 mods 则允许运行中保存，返回 requiresRestart:true。其他运行中配置变更仍需关闭游戏。GET status 增加服务器已保存 mods。
2026-10-22：POST /api/game/update 通过后台任务调用 SteamCMD 更新并校验饥荒服务端（App 343050）。更新与安装共用全局互斥，开始前检查所有房间世界均已停止；任务完成前不会覆盖运行中的游戏文件。前端控制台提供“更新游戏”按钮并显示任务状态。

2026-10-20：GET /api/rooms/:id/map 返回 image（data:image/png;base64）、尺寸、真实采集时间和图例；不再返回 SVG。服务端和浏览器缓存 60 秒。POST control 的 check 查询科雷大厅并返回 listed、matches、candidates、complete、checkedRegions、errors、checkedAt 和 message；部分区域查询失败不直接断言房间下线。POST mods/config 支持常见语言判断、拼接和生成选项，无法处理时返回 422 及可显示原因；fields=[] 表示模组没有选项。前端读取 schema 时优先保留当前草稿参数。

2026-10-20 模组管理改进：

- 游戏运行时允许下载已安装模组的更新，文件暂存在持久化目录。全部共享房间停止后，下次启动时再替换安装目录；下载完成会标注“待重启”，不会自动打断游戏。
- 已安装列表显示“已是最新／有更新／待重启／版本待检查”，对比 Steam 安装清单记录的本地更新时间与工坊更新时间；没有本地版本凭据时显示未知，不把当前查询结果当作本地版本。刷新按钮可强制检查工坊。查询失败保留上次结果并提示。
- 使用紧凑卡片，突出启用、配置与下载更新按钮。下载任务显示百分比及已传输 MB；旧版公开工坊包支持按 HTTP 字节统计，SteamCMD 支持读取 content 日志字节。连接与初始化无百分比时保持等待状态，不编造递增进度。
- 配置优先使用模组原生中文，并自动替换内置词典中的英文标签、说明和选项。已覆盖当前 Global Positions、Fast Travel、Restart 常用配置；未收录文本保留原文，悬停可查看已翻译文本的英文原文。仅修改显示文本，不修改配置键、实际值或 Lua 文件；不调用付费翻译服务。


2026-10-19 模组配置兼容修复：补齐有计算预算的 Lua 字符串查找、函数多返回值、自定义迭代器，并传入实际工坊目录名。云服所装永不妥协（2039181790）读取 219 个配置项；69 个标题/间隔条目按分组标题或留空处理，不生成空键下拉框。Insight（2189004162）读取 116 个配置条目，原生中文正常。仅解释配置数据，仍不开放系统执行或动态加载。Windows 后端测试 26 通过、1 项 Linux 测试跳过，78 项 DOM 检查通过；未启动前端服务器或浏览器，未做浏览器视觉验收。


2026-10-19 配置汉化修正：撤销删除残留英文、通用说明和“选项编号”的兜底。新增 552 条经过逐项翻译的完整文本，覆盖当前永不妥协版本的 219 个设置、分组、说明和选项；保留数字、崩溃风险及已损坏标记。其他模组优先使用原生中文和精确词条；未知文本保留原文。英文作者署名、快捷键和其他模组名称可以保留。所有配置键、默认值和实际选项值保持不变。Windows 后端 29 通过、Linux 专项 1 跳过；78 项 DOM 检查通过，未运行浏览器。

2026-10-21：地图接口移除纯色块绘制器，使用已安装服务端的原版 KTEX 地形纹理、地图图标及道路绘制高分辨率 PNG。资源不随开源包分发。返回 renderer=klei-textures-v1、imageWidth/imageHeight、iconCount、roadCount、missingTerrains；地形基于最近存档，独立于游戏控制台。渲染单并发、相同内容合并请求、最多缓存两张地图，Python 进程限时 60 秒、Linux 地址空间上限 512 MiB。浏览器允许最多 120 秒。

2026-10-21：地图接口移除纯色块绘制器，使用已安装服务端的原版 KTEX 地形纹理、地图图标及道路绘制高分辨率 PNG。资源不随开源包分发。返回 renderer=klei-textures-v1、imageWidth/imageHeight、iconCount、roadCount、missingTerrains；地形基于最近存档，独立于游戏控制台。渲染单并发、相同内容合并请求、最多缓存两张地图，Python 进程限时 60 秒、Linux 地址空间上限 512 MiB。浏览器允许最多 120 秒。

2026-10-21 玩家移出修复：POST /api/rooms/:id/players/kick 接受 userid，仍返回后台任务 ID。服务端使用游戏原生 TheNet:Kick(UserToClientID(userid) or userid)，发往所有运行中的世界；查询只包含当前连接的 userid，不依赖角色是否进入世界，也不使用地图或状态缓存。只有新查询确认目标已从所有运行世界离线，任务才 succeeded，result 为 {kicked:true, confirmed:true, userid}。玩家仍在线、世界状态变化或实时查询失败均返回 failed。前端等待任务确认后显示成功弹窗，处理中防止同一玩家重复提交。移出不会写入黑名单，玩家可再次加入。


2026-10-21 玩家管理与排行榜：GET /api/rooms/:id/players 新增 statistics（startedAt、sampleSeconds、complete、totalPlayers、totalSeconds）。ranking 为当前房间全部已记录玩家，按实际采样累计的 playSeconds 降序，包含 prefab、playerDays、firstSeen、lastSeen、online（采集不完整时为 null）。online 仍只包含当前采集到的在线玩家。后台每 15 秒独立采集并持久化 SQLite；前端浏览次数不会重复计时。跨世界按科雷 ID 去重，只有同一进程连续完整采集、间隔不超过 45 秒且两次都在线才累计时长；采集失败、离线、重启或长时间空档不补算。统计与游戏角色天数分开，安装前历史不推算。前端四个分类红色操作按钮，原版角色中文名及头像，排行榜总量统计、前十时长条形图和含离线玩家的资料卡。未知模组角色保留标识。浏览器测试数据不写入服务器。

2026-10-21 日志读取修复：GET /api/rooms/:id/logs 对每个世界的游戏日志和聊天日志分别从末尾按完整行读取，过滤后各保留最多 500 条有效记录；每个文件最多向前扫描 8 MiB。采集命令带 FEATHER_TELEMETRY 注释标记，同时兼容过滤旧版本的固定采集命令和 FP 回包，保留真实 Lua 错误、调用栈、手动控制命令及玩家聊天。读取块边界不解码半个 UTF-8 字符，扫描边界丢弃不完整首行，清理终端颜色和控制字符。time 单独返回，message 不重复包含游戏时间前缀；复制日志仅出现一次时间。原始服务器日志不被修改或删除。

2026-10-21 地图无损提速：预计算八方向边缘覆盖，按等价的二值目标距离选择原版边缘；重复纹理先在小块上染色，再平铺。分辨率、地形、道路、图标和返回协议保持一致。云服同一份 3560×3560 地图的两轮独立 Python 渲染耗时由 5200/5049 ms 降至 3549/3634 ms，像素及元数据完全一致；此为渲染阶段耗时，不包含存档读取、网络传输和浏览器解码。PNG 仍为无损格式。


2026-10-21 控制台独立世界管理：GET /api/rooms/:id/worlds 返回 {worlds,operationPending}，不调用 Lua 状态采集。每个世界包含 running 和 resources：available、cpuPercent、memoryBytes、memoryPercent、memoryLimitBytes、sampledAt、processCount。Linux 下仅匹配本房间、本世界的游戏二进制进程；CPU 按两次内核计数器差值采样，单核满载为 100%，多核可超过 100%；首次采样为 null。内存为该世界进程 RSS，百分比按主机内存与容器内存限制的较小值计算。停止时为 0；运行但进程数据不可读时为 null，不沿用旧值。前端每 3 秒更新，保留最多 30 个趋势点。

POST /api/rooms/:id/worlds/control 接受 {worldID,action:'start'|'stop'}，返回 taskID；必须等待任务完成。与整房间操作共享房间锁。start 使用服务器已保存的配置及模组，只启动指定世界；返回 running:true 表示进程已启动，游戏就绪仍以日志为准。stop 向指定世界发送安全关闭命令并等待退出，超时失败，不强杀。其他世界不发送启停命令。
