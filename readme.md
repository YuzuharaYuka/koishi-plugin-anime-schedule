# koishi-plugin-anime-schedule

番剧更新表与订阅提醒，提供日、周、季三张表，支持定时推送、订阅、搜索与详情。

## 安装

```bash
npm i koishi-plugin-anime-schedule
```

需要 `database` 与 `http` 服务；封面和评分走代理时可选装 [proxy-agent](/market/?keyword=proxy-agent)。

## 指令

| 指令 | 别名 | 说明 |
| :--- | :--- | :--- |
| `anime` | 番剧 / 新番 | 今日更新表 |
| `anime.today [-o 偏移]` | 今日新番 | 今日更新；`-o -1` 查看前一天 |
| `anime.night` | 深夜新番 | 今晚深夜档 |
| `anime.week` | 本周新番 | 今天起七天 |
| `anime.season [季度]` | 本季新番 | 本季或指定季度 |
| `anime.search <关键词> [-l 数量]` | 番剧搜索 | 搜索作品，默认 10 条 |
| `anime.info <ID 或关键词>` | 番剧详情 | 简介、状态、话数与评分 |
| `anime.sub <ID>` | 番剧订阅 | 按 Bangumi 条目 ID 订阅 |
| `anime.remove <ID 或序号>` | 退订 | 按 ID 或列表序号取消 |
| `anime.list` | 订阅列表 | 查看本会话订阅 |
| `anime.clear` | 清空订阅 | 清空本会话订阅 |
| `anime.next [天数]` | 追番计划 | 订阅作品未来排期 |
| `anime.on` / `anime.off` | 开启推送 / 关闭推送 | 本群推送开关，可指定类型 |
| `anime.status` | 推送状态 | 查看本群推送设置 |
| `anime.push <类型>` | 立即推送 | 手动发送一次 |

季度支持 `2026-07`、`2026年7月`、`26夏`；加 `-o -1`、`-o 1` 查看相邻季度。

卡片上的 `ID:400602`、详情页脚 ID 和搜索结果序号都可用于订阅或查询详情。

## 配置

### 基础

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `timeZone` | `Asia/Shanghai` | 日期与时刻的换算时区 |
| `locale` | `zh-CN` | 文案语言，不影响标题 |

### 推送

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `dailyEnabled` | `true` | 每日更新表 |
| `nightEnabled` | `true` | 深夜档更新表 |
| `weeklyEnabled` | `true` | 本周更新表 |
| `seasonEnabled` | `true` | 本季新番表 |
| `updateReminderEnabled` | `true` | 订阅开播提醒 |

### 时间

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `dailyTime` | `08:00` | 每日推送时刻 |
| `nightRange` | `21:00–06:00` | 深夜档起止时间 |
| `nightTime` | `21:00` | 深夜档推送时刻 |
| `weeklyTime` | `08:00` | 周表推送时刻 |
| `seasonTime` | `08:00` | 季度首日推送时刻 |
| `weeklyWeekday` | `周一` | 周表推送星期 |
| `dailyOffsetDays` | `0` | 定时每日表的日期偏移 |

### 范围

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `maxPerChannel` | `0` | 单个会话订阅上限 |
| `maxItems` | `0` | 单个番组表最多显示几部 |

### 输出

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `format` | `image` | 番组表与详情输出形态 |
| `layout` | `table` | 番组表图片排版 |
| `showCover` | `true` | 图片中显示封面 |
| `showScore` | `true` | 显示 Bangumi 评分 |
| `useForward` | `true` | 多段文本使用合并转发 |

### 图片

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `fontFamily` | `Anime Schedule Sans` | 图片字体，可填本机字体 |
| `coverMaxEdge` | `650` | 封面解码边长（像素） |
| `coverLimit` | `0` | 单张图封面数上限 |
| `coverCacheDays` | `21` | 封面缓存天数 |
| `jpegQuality` | `90` | JPEG 质量（1–100） |
| `supersample` | `3` | 超采样倍数（1–5） |

### 本地化

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `enabled` | `true` | 使用中文标题与评分 |
| `titleStyle` | `localized` | 标题展示方式 |

### 高级

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `requestTimeout` | `10` | 默认请求超时（秒） |
| `retries` | `2` | 失败重试次数 |
| `debug` | `false` | 调试日志（含用户输入） |

完整配置见控制台。

## 注意事项

- 每日、深夜、本周表只列仍在播出的作品；本季表收录该季首播的 TV / WEB 动画。
- 时间轴虚线表示当前时刻，上方已播出，下方未播出。
- 播出时刻优先取 AniList，缺失时按放送周期推算；播完的作品会从更新表和订阅列表移除。
- 定时推送与开播提醒都会去重，不会重复发送。
- `anime.list` / `anime.clear` 在群聊与私聊都可用；`anime.on` / `anime.off` / `anime.status` 只适用于群聊。
- 调试日志可能包含搜索词与指令参数，排查后请关闭。

## 常见问题

**时间与某个站点差 1 小时？** 检查 `timeZone`，日本时间是 UTC+9。

**显示已更新但看不到播放源？** 时刻以日本电视台档期为准，配信平台可能提前或延后。

**当季新番没出现？** 本季表只收 TV / WEB；也可能尚未被 bangumi-data 收录。

**老番出现在今日表？** 条目仍在更新，或上游数据尚未完结。

**封面或评分一直加载失败？** 通常是网络无法访问 Bangumi 图床或接口，安装 [proxy-agent](/market/?keyword=proxy-agent) 并配置代理。

**封面看起来模糊？** 把 `coverMaxEdge` 调大，可到 2048；会占用更多内存和磁盘。

**图片生成很慢或占用内存很高？** 调低 `supersample`、`jpegQuality`，或把 `coverLimit` 设为 40 左右。

**没有收到定时推送？** 先在群聊执行 `anime.on`，再用 `anime.status` 检查开关；仍没有就核对控制台的推送时刻。

## 致谢

- [bangumi-data](https://github.com/bangumi-data/bangumi-data)：作品清单、中文标题与放送周期。
- [Bangumi 番组计划](https://bgm.tv/)：封面与评分。
- [AniList](https://anilist.co/)：封面、播出时刻与状态。

## License

MIT
