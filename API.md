# 景区应急联动中心 - 后端告警服务 API 文档

## 一、服务概述

本服务作为景区客服系统、广播系统、领导短信之间的舆情触发器，围绕**三项核心能力**提供 REST 接口：

| 模块 | 核心功能 | 接口前缀 |
|------|----------|----------|
| 规则管理 | 风险关键词、组合条件、责任部门、阈值配置 | `/api/rules` |
| 告警记录与分级推送 | 内容匹配、三级分级、告警聚合、统计概览 | `/api/alerts` |
| 告警闭环回填 | 部门状态回填、历史轨迹、避免重复催办 | `/api/callbacks` |

**告警三级定义：**
- `notice` - 一般关注（低，推送值班群观察）
- `verify` - 需核实（中，通知责任部门现场确认）
- `emergency` - 紧急处置（高，同时推送领导短信+值班群）

---

## 二、规则管理模块 `/api/rules`

### 2.1 规则字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `rule_name` | string | 是 | 规则名称，如"踩踏风险预警" |
| `keywords` | array[string] | 是 | 重点词数组，如 `["踩踏","拥挤","人太多"]` |
| `combine_logic` | string | 否 | 组合逻辑：`or`(默认) 任一命中 / `and` 全部命中 |
| `department` | string | 是 | 责任部门，如"安保部"、"索道运营部" |
| `alert_level` | string | 否 | 默认告警等级：`notice` / `verify`(默认) / `emergency` |
| `threshold_count` | int | 否 | 阈值次数，默认 3 次 |
| `threshold_minutes` | int | 否 | 阈值时间窗口（分钟），默认 10 分钟 |
| `verify_action` | string | 否 | 建议核实动作，会填入告警消息 |
| `status` | int | 否 | 启用状态：1 启用(默认) / 0 禁用 |

### 2.2 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/rules` | 规则列表（分页+状态过滤） |
| GET | `/api/rules/:id` | 单条规则详情 |
| POST | `/api/rules` | 新增规则 |
| PUT | `/api/rules/:id` | 修改规则 |
| PATCH | `/api/rules/:id/status` | 启停切换 |
| DELETE | `/api/rules/:id` | 删除规则 |

---

## 三、告警记录模块 `/api/alerts`

### 3.1 告警等级与推送目标

| 等级值 | 显示名 | 触发条件 | 推送目标 |
|--------|--------|----------|----------|
| `notice` | 一般关注 | 满足阈值，等级低 | 值班群 |
| `verify` | 需核实 | 满足阈值，等级中 | 责任部门接口 + 值班群 |
| `emergency` | 紧急处置 | 满足阈值，等级高 | 领导短信 + 责任部门 + 值班群 |

> 告警会随匹配数量升级：低等级告警若持续触发，会自动提升到更高等级。
> 同规则在阈值时间窗口内只生成 1 条告警，新内容自动累加到 `matched_count`，避免重复推送。

### 3.2 消息接入接口（核心）

**POST `/api/alerts/ingest`** - 接收单条舆情消息并匹配告警

```json
// 请求
{
  "content": "北门这边人挤不动了，感觉要踩踏了，太危险",
  "source_platform": "客服工单系统",
  "suspected_location": "景区北门入口广场"
}
```

| 字段 | 说明 |
|------|------|
| `content` | 消息原文（必填） |
| `source_platform` | 来源平台，如"微博评论"、"客服热线"、"投诉工单" |
| `suspected_location` | 疑似地点，若上游系统可识别则填入 |

```json
// 响应
{
  "code": 0,
  "message": "匹配完成，部分规则已触发告警",
  "data": {
    "matched": true,
    "matched_rules_count": 1,
    "triggered_alerts_count": 1,
    "trigger_details": [
      {
        "rule_id": 1,
        "rule_name": "踩踏风险预警",
        "matched_keywords": ["踩踏", "挤不动"],
        "reached_threshold": true,
        "current_count": 5,
        "required_count": 5,
        "alert_uuid": "a1b2c3d4-..."
      }
    ],
    "push_payloads": [
      {
        "alert_uuid": "a1b2c3d4-...",
        "rule_name": "踩踏风险预警",
        "alert_level": "emergency",
        "level_name": "紧急处置",
        "department": "安保部",
        "matched_count": 5,
        "content_summary": "北门这边人挤不动了，感觉要踩踏了...",
        "source_platform": "客服工单系统",
        "suspected_location": "景区北门入口广场",
        "matched_keywords": ["踩踏", "挤不动"],
        "verify_action": "立即派员前往现场核实客流密度...",
        "created_at": "2026-06-19T00:12:34",
        "is_new": true
      }
    ]
  }
}
```

**`push_payloads` 即为下游推送接口可直接使用的数据结构**（值班群/短信/接口）。

**批量接入：POST `/api/alerts/batch-ingest`**
```json
{ "messages": [ { "content": "...", "source_platform": "..." }, ... ] }
```

### 3.3 查询接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/alerts` | 告警列表，支持 `status` / `alert_level` / `department` 过滤 + 分页 |
| GET | `/api/alerts/:id` | 按自增ID查详情（含回填历史） |
| GET | `/api/alerts/uuid/:uuid` | 按告警UUID查详情（**回填接口推荐使用**） |
| GET | `/api/alerts/statistics/summary` | 统计概览（按等级/状态/部门分布 + 今日指标） |

---

## 四、告警闭环回填模块 `/api/callbacks`

### 4.1 设计说明

回填接口的核心目标是**避免重复催办**：
- 接收部门通过回填告知"已联系"、"现场正常"等状态
- 服务自动将告警状态流转为 `processing` / `verified_normal` / `closed` 等
- 已关闭或核实正常的告警，后续同类匹配不再重复推送新告警
- 每次回填留痕，完整记录事件处置轨迹

### 4.2 获取回填状态字典

**GET `/api/callbacks/status-options`**

响应会返回所有允许的回填选项，前端直接渲染下拉即可：

```json
{
  "code": 0,
  "data": {
    "callback_options": [
      { "value": "contacted", "label": "已联系", "description": "已与责任部门或相关人员取得联系" },
      { "value": "onsite", "label": "已到场", "description": "工作人员已抵达现场" },
      { "value": "verified_normal", "label": "现场正常", "description": "经现场核实，无异常情况，可关闭" },
      { "value": "plan_activated", "label": "启动预案", "description": "已按应急预案开展处置工作" },
      { "value": "escalated", "label": "已升级上报", "description": "已上报至更高层级领导或部门" },
      { "value": "false_alarm", "label": "误报", "description": "经核实为误报，无需进一步处置" },
      { "value": "resolved", "label": "已办结", "description": "事件已处置完毕，流程闭环结束" }
    ]
  }
}
```

### 4.3 提交回填（核心接口）

**POST `/api/callbacks`**

```json
// 请求
{
  "alert_uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "callback_status": "verified_normal",
  "callback_remark": "现场安保已到位，客流已疏导，一切正常",
  "operator": "张三（安保部值班）"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `alert_uuid` | `alert_id` 和 `alert_uuid` 至少填一项 | 告警的唯一标识（**推荐使用**，方便外部系统关联） |
| `alert_id` | 同上 | 告警的数字自增ID |
| `callback_status` | 是 | 回填状态值，见上文字典 |
| `callback_remark` | 否 | 处置说明/备注 |
| `operator` | 否 | 操作人姓名+部门 |

```json
// 响应
{
  "code": 0,
  "message": "回填成功：现场正常",
  "data": {
    "alert_uuid": "a1b2c3d4-...",
    "alert_id": 12,
    "callback_status": "verified_normal",
    "callback_label": "现场正常",
    "alert_updated_status": "verified_normal",
    "alert_updated_status_label": "核实正常",
    "avoid_duplicate_push": true
  }
}
```

> `avoid_duplicate_push: true` 表示服务已识别此告警为完结状态，后续不再生成重复催办。

### 4.4 查询回填轨迹

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/callbacks/alert/:id` | 按告警ID查回填历史 |
| GET | `/api/callbacks/alert-uuid/:uuid` | 按告警UUID查回填历史（**推荐**） |
| GET | `/api/callbacks/recent` | 最近回填记录列表（默认50条） |

---

## 五、典型使用流程示例

```
1. 景区工作人员登录后台 → 配置/启用规则（POST /api/rules）
     例：关键词 ["缆车停了","索道故障"]，部门"索道运营部"，阈值3次/15分钟，等级verify

2. 客服系统 → 持续同步工单、热线、舆情 → POST /api/alerts/ingest
     例：15分钟内出现 4 条含"缆车停了"的投诉

3. 告警服务 → 命中规则 → 生成 1 条告警（matched_count=4） → 推送值班群
     push_payloads[0] 直接作为群机器人 / 部门接口的请求体

4. 索道部值班员 → 在OA群点击"已到场"按钮 → 调用 POST /api/callbacks
     { alert_uuid: "...", callback_status: "onsite", operator: "李四" }

5. 现场确认无故障 → 再次回填 POST /api/callbacks
     { alert_uuid: "...", callback_status: "verified_normal", remark: "已重启，正常运行" }
     → 服务自动标记 avoid_duplicate_push = true，后续同类消息不再推送新告警
```
