# 体育馆预约微信小程序（gymreserve）

面向校内学生的体育馆线上预约小程序：三馆场地预约（先到先得、免费）、动态二维码防截图签到、爽约自动拉黑、公告通知、管理员运营（签到/拉黑/闭馆/日志/人事）。
S
- 技术栈：微信小程序（原生）+ 微信云开发（单云函数统一入口 + 云数据库 + 云存储 + 定时触发器）
- 鉴权：微信 openid
- 云函数端仅依赖 `wx-server-sdk`，无其他 npm 依赖

---

## 一、目录结构

```
gymreserve/
├── project.config.json          # 微信开发者工具项目配置
├── README.md
├── miniprogram/                 # 小程序前端
│   ├── app.js / app.json / app.wxss / sitemap.json
│   ├── config/config.js         # ★云环境 ID 填写处（前端）
│   ├── utils/ (request.js / util.js / qrcode.js)
│   ├── components/notice-modal/ # 公告弹窗组件
│   ├── images/
│   └── pages/ (index/guide/mine/booking/qrcode/my-reservations/records/notice/profile/admin/*)
└── cloudfunctions/cloud/        # 云函数（单函数统一入口）
    ├── index.js / package.json / config.json
    ├── config/config.js         # ★云环境 ID / 超管 openid / 密钥 填写处（云端）
    ├── config/route.js          # 路由表
    ├── framework/               # core / database / client / utils
    └── project/                 # controller / service / model / init
```

---

## 二、部署步骤（按顺序）

### 1. 填写云环境 ID（两处保持一致）

- `miniprogram/config/config.js` 中的 `CLOUD_ID`
- `cloudfunctions/cloud/config/config.js` 中的 `CLOUD_ID`

### 2. 填写初始超级管理员 openid

`cloudfunctions/cloud/config/config.js` 中的 `INIT_ADMIN_OPENID`。
首次部署若不知道 openid，可先留空，部署后在云开发控制台 → 数据库 → users 集合中，手动把某条学生的 `role` 改为 `3`（超级管理员）即可；或填写后重新运行初始化脚本。

### 3. 在微信开发者工具中打开项目

- 导入项目根目录 `gymreserve/`，AppID 用你自己的小程序 AppID（`project.config.json` 中当前为 `wx18ef612302a31119`，请替换成你自己的）。

### 4. 开通云开发并部署云函数

1. 点击工具栏「云开发」开通环境，记录环境 ID。
2. 在 `cloudfunctions/cloud` 目录右键 →「上传并部署：云端安装依赖」。
3. 部署完成后，右键云函数 `cloud` →「云端测试」，传入初始化参数并运行：

```json
{ "route": "init/run", "job_secret": "gymreserve-job-secret-2026" }
```

> 该脚本会自动创建 11 个集合、写入 32 个场馆、6 个场次模板、默认配置，并按 `INIT_ADMIN_OPENID` 创建/提升超级管理员。可重复执行（幂等）。**唯一索引例外，需手动创建，见第 5 步。**

### 5. 预约防重复的组合唯一索引（⚠️ 需手动创建一次）

`reservations` 集合的 `_id` 已由 `日期_场次_场地` 组合主键保证「场地不超约」（天然唯一，无需额外建索引）；「同一学生同一时间窗跨场馆只约 1 个」由组合唯一索引 `uniq_student_slot`（`student_openid + date + slot_key`，唯一）保证。

> **该索引无法由 `init/run` 自动创建。** `wx-server-sdk` 的 `Collection` 实例并未提供 `createIndex` 方法（依赖链 `wx-server-sdk` → `@cloudbase/node-sdk` → `@cloudbase/database` 三层均未暴露该 API），初始化脚本检测不到该方法时会打印告警并跳过，因此**必须按下表在控制台手动建一次**。

在云开发控制台 → 数据库 → `reservations` 集合 → 索引管理 → 新建索引：

| 索引字段 | 索引类型 | 是否唯一 |
|---|---|---|
| student_openid | 升序 | — |
| date | 升序 | — |
| slot_key | 升序 | — |

- **索引名称**：`uniq_student_slot`
- **唯一**：是

> 若索引缺失，系统仍能保证「场地不超约」；`reservation_service.create` 内也做了一次「同一学生同时间窗是否已约其他场地」的查询兜底，所以 4101 依然会触发。但应用层「先查后插」存在并发竞态窗口，高并发下不如数据库唯一索引可靠。请在首次部署后到控制台确认索引列表中存在 `uniq_student_slot`。

### 6. 定时触发器

`cloudfunctions/cloud/config.json` 已声明两个定时触发器（部署云函数时自动生效）：

- `gymreserve-expire`：每小时整点，执行爽约扫描（`job/expire`）+ 黑名单到期自动解除（status=active 且已到期 → released）
- `gymreserve-notify`：每 5 分钟，执行预约提醒（`job/notify`，P1）

如需手动触发（云端测试），可传：

```json
{ "route": "job/expire", "job_secret": "gymreserve-job-secret-2026" }
```

---

## 三、角色与权限

| 角色 | role 值 | 权限 |
|---|---|---|
| 学生 | 1 | 预约/取消/二维码/我的记录 |
| 普通管理员 | 2 | + 扫码签到、签到记录、手动拉黑、公告管理 |
| 超级管理员 | 3 | + 解除拉黑、场地闭馆、系统日志、配置/活动图 |
| 老师 | 4 | 兼任超管全部 + 人事管理 |
| 现任主席 | 5 | 同老师（最高） |

- 老师/主席兼任超级管理员全部权限；人事（role≥4）仅老师/主席。
- 首次登录自动注册为「学生」；管理员由超管/老师/主席在 users 表中配置角色，或在「人事管理」中任免。

---

## 四、核心业务规则（已与客户确认）

1. 场馆：羽毛球 6、乒乓球 6、健身房 20；场地唯一标识 `场馆类型#编号`（如 `badminton#3`）。
2. 场次：工作日 2 场（18:20~19:30、19:40~20:50）；周末 6 场（13:00 起每 70 分钟一场）；`slot_key` 如 `1820_1930`。
3. 预约：前一天 21:00 开放次日；先到先得；免费；同一学生同一时间窗跨场馆只限 1 个；开始前 30 分钟可取消，取消后场地立即释放。
4. 并发不超约：`reservations._id = 日期_场次_场地` + 组合唯一索引 `uniq_student_slot`，在 `db.runTransaction` 内 add，冲突映射 4100/4101。
5. 动态二维码：服务端生成随机 token，20 秒过期，前端每 20 秒重取 + canvas 自绘；管理员扫码后服务端按 token 校验（4103 过期）。
6. 签到：窗口 = 开始前 15 分钟至结束；`admin/checkin` 登记附属人员，`checkin_records._id=res_id` 幂等，状态 pending→checked_in。
7. 拉黑：auto=爽约固定 10 天（`job/expire` 每小时扫描，原子更新幂等）；manual=自定义时长；到期自动解除；超管可提前解除（逻辑删除 status=released）。
8. 公告：普通管理员发布/修改/删除（逻辑删除）；学生每次进入弹最新一条（`notice/latest`，匿名可看）。
9. 场地闭馆：超管按场馆+编号临时闭馆/恢复，闭馆场地不可约。
10. 系统日志：拉黑/解除/人事/闭馆/公告删改/配置修改均写 `operation_logs`。

---

## 五、错误码

| code | 含义 |
|---|---|
| 200 | 成功 |
| 500 | 服务器错误 |
| 1301 | 参数校验错误 |
| 1600 | 通用逻辑错误 |
| 4001 | 未登录 |
| 4003 | 无权限 |
| 4004 | 被拉黑（data 附剩余天数 black_days） |
| 4010 | 未完善个人信息 |
| 4100 | 场地已被预约 |
| 4101 | 同一时间窗只能约一个场地 |
| 4102 | 不在开放时间 |
| 4103 | 二维码过期需刷新 |
| 4104 | 无对应有效预约 |
| 4105 | 预约场次不匹配 |
| 4106 | 场地闭馆不可预约 |
| 4107 | 已过取消时间 |

统一返回结构：`{ code, msg, data }`。

---

## 六、P1/P2 说明

- **P1 消息推送**：已做基础实现（`message/subscribe` + `job/notify` 扫描提醒 + `message_service.sendSubscribe`）。需在 `config/config.js` 的 `SUBSCRIBE_TPL` 中配置订阅消息模板 ID，并在小程序端发起订阅授权，才能真实下发。
- **P1 活动图片更换**：已实现 `config/activity_pic`（超管上传 fileID 后保存到 `configs`）。
- **P2 场次/开放时间配置**：已实现 `config/set`（当前支持 `open_time`），场次模板可在 `configs`/`time_slots` 集合中维护。

---

## 七、注意事项

1. 二维码有效性、预约开放时间、签到窗口均以**服务端时间（东八区）**为准，不依赖前端时间。
2. 微信云函数运行环境默认东八区；本项目时间工具已强制按东八区计算，避免时区差异。
3. 云函数依赖仅 `wx-server-sdk`，无需 npm 安装其他包。
