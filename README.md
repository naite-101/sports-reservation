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
3. 在云开发控制台 → 云函数 `cloud` → 配置 → 环境变量，新增 `JOB_SECRET`（值用一串强随机字符串，例如 `openssl rand -hex 24` 生成）。`init/run`、`job/*` 的手动调用都依赖它，未配置时这些入口一律拒绝。
   - `smoke/run` 额外需要环境变量 `ENABLE_SMOKE=1` 才会放行（默认关闭，防止生产库被冒烟测试写删；排查完毕请删掉该变量）。
   - HTTP 访问服务通道只放行只读接口（`notice/latest`、`notice/list`、`notice/detail`、`config/get`、`banner/list`），其余路由一律 403。外部压测请使用测试环境，勿在生产开 HTTP 写通道。
4. 部署完成后，右键云函数 `cloud` →「云端测试」，传入初始化参数并运行：

```json
{ "route": "init/run", "job_secret": "<JOB_SECRET>" }
```

> `<JOB_SECRET>` 用你第 3 步配置的环境变量值替换。该脚本会自动创建 11 个集合、写入 32 个场馆、6 个场次模板、默认配置，并按 `INIT_ADMIN_OPENID` 创建/提升超级管理员。可重复执行（幂等）。防重复机制见第 5 步（锁表兜底，唯一索引为可选优化）。

### 5. 预约防重复机制（锁表兜底，唯一索引为可选优化）

防超约/防重复由两层机制保证，**不依赖手动建索引**：

1. **场地不超约**：`reservations` 集合 `_id = 日期_场次_场地` 组合主键，天然唯一，同场地同场次只允许一条占用。
2. **同一学生同一时间窗只约 1 个场地**：`student_slot_locks` 锁表 `_id = openid_日期_场次` 组合主键，预约事务内加锁、取消/闭馆/爽约三条路径释放锁（`job/expire` 另有孤儿锁清扫兜底）。

> 旧文档要求手动创建的 `reservations` 组合唯一索引 `uniq_student_slot`（`student_openid + date + slot_key`）**已降级为可选优化**——锁表主键已在数据库层原子拦截重复预约。若你想额外加一层保险，可在控制台 → 数据库 → `reservations` → 索引管理手动创建（名称 `uniq_student_slot`，三字段升序，唯一），缺失不影响正确性。

### 6. 定时触发器

`cloudfunctions/cloud/config.json` 已声明两个定时触发器：

- `gymreserve-expire`：每 10 分钟，执行爽约扫描（`job/expire`）+ 黑名单到期自动解除（status=active 且已到期 → released）
- `gymreserve-notify`：每 5 分钟，执行预约提醒（`job/notify`，P1）

> **⚠️ 触发器只在云函数首次创建时自动生成**，后续用「上传并部署」更新代码不会同步重建触发器。部署后请到云开发控制台 → 云函数 `cloud` → 触发器，确认 `gymreserve-expire`、`gymreserve-notify` 两个触发器存在且启用；缺失就手动新建（类型=定时触发，cron 见 `config.json`）。否则爽约不会自动拉黑、黑名单到期不会自动解除。

如需手动触发（云端测试），可传：

```json
{ "route": "job/expire", "job_secret": "<JOB_SECRET>" }
```

---

## 三、角色与权限

| 角色 | role 值 | 权限 |
|---|---|---|
| 学生 | 1 | 预约/取消/二维码/我的记录 |
| 普通管理员 | 2 | + 扫码签到、签到记录、公告管理 |
| 超级管理员 | 3 | + 拉黑学生、修改成员信息、解除黑名单、场地闭馆、系统日志、配置/活动图 |
| 人事管理员 | 4 | 拥有超管全部权限，另可任命超级管理员与人事管理员（超管不可） |

- 人事管理员（原「老师/主席」已合并）**拥有超级管理员全部权限**，独有权限为：任命超级管理员、任命人事管理员。
- 拉黑学生、修改成员信息、解除黑名单：超管(3)与人事管理员(4)共有。
- 首次登录自动注册为「学生」；管理员在「人事管理」中任免。

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
9. 场地闭馆：超管按场馆+编号临时闭馆/恢复；临时闭馆按**场次**判定——场次开始时间晚于恢复时刻的可正常预约，只有恢复时刻之前开始的场次被锁定。
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
