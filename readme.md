# koishi-plugin-anime-schedule

[Koishi](https://koishi.chat/) 的番剧更新表与订阅提醒插件。

作品清单与中文标题来自 [bangumi-data](https://github.com/bangumi-data/bangumi-data)；封面来自 [Bangumi](https://bgm.tv/) 与 [AniList](https://anilist.co/)，评分来自 Bangumi，播出时刻与状态来自 AniList。

## 安装

```bash
npm i koishi-plugin-anime-schedule
```

启用插件后，在群聊执行 `anime.on` 开启定时推送。

## 指令

主指令 `anime`，别名 `番剧`、`新番`。

| 指令 | 别名 | 说明 |
| :--- | :--- | :--- |
| `anime` | — | 今日更新表 |
| `anime.today [-o 偏移]` | 今日新番 | 今日更新；`-o -1` 查看前一天 |
| `anime.night` | 深夜新番 | 今晚 21:00 至次日 06:00 |
| `anime.week` | 本周新番 | 今天起七天 |
| `anime.season [季度]` | 本季新番 | 本季或指定季度 |
| `anime.search <关键词> [-l 数量]` | 番剧搜索 | 搜索作品，默认显示 10 条 |
| `anime.info <ID 或关键词>` | 番剧详情 | 作品详情；关键词可命中多部 |
| `anime.sub <ID>` | 番剧订阅 | 按 Bangumi 条目 ID 订阅 |
| `anime.remove <ID 或序号>` | 退订 | 按 ID 或列表序号取消 |
| `anime.list` | 订阅列表 | 本会话订阅的番剧 |
| `anime.clear` | 清空订阅 | 删除本会话全部订阅 |
| `anime.next [天数]` | 追番计划 | 订阅作品未来 1–31 天的排期 |
| `anime.on` / `anime.off` | 开启推送 / 关闭推送 | 本群推送开关，可指定类型 |
| `anime.status` | 推送状态 | 本会话推送状态 |
| `anime.push <类型>` | 立即推送 | 手动发送一次 |

季度支持 `2026-07`、`2026年7月`、`26夏`，也可以用 `-o -1`、`-o 1` 查看相邻季度。

卡片上的 `ID:400602`、详情页脚的 ID 和搜索结果序号，都可以用于订阅或查询详情。

## 配置

在 Koishi 控制台按分组配置：

- **基本**：时区、文案语言。
- **推送**：每日、深夜、本周、本季推送，以及订阅开播提醒。
- **订阅**：单会话订阅上限。
- **番组表内容**：番组表条数、更新表中的长期连载过滤。
- **输出**：番组表与详情的图片 / 文本、番组表图片排版、封面、评分、合并转发。
- **图片**：字体、封面并发与缓存、JPEG 质量、超采样。
- **本地化**：中文标题与评分、标题样式、缓存时长。
- **高级**：默认请求超时、重试次数、调试日志。

## 说明

- 每日、深夜、本周表只列仍在播出的作品；本季表收录该季首播的 TV / WEB 动画。
- 时间轴虚线表示当前时刻：上方已播出，下方未播出。
- 完结判定综合 AniList 状态与 Bangumi 档期；播完的作品会从更新表和订阅列表移除。
- 播出时刻优先取 AniList，缺失时按放送周期推算。
- 定时推送与开播提醒都会去重，避免重复发送。

## 常见问题

**时间与某个站点差 1 小时？** 检查 `timeZone`，日本时间是 UTC+9。

**显示已更新但看不到播放源？** 时刻以日本电视台档期为准，配信平台可能提前或延后。

**当季新番没出现？** 本季表只收 TV / WEB；也可能尚未被 bangumi-data 收录。

**老番出现在今日表？** 条目仍在更新，或上游数据尚未完结。

## 致谢

- [bangumi-data](https://github.com/bangumi-data/bangumi-data)：作品清单、中文标题与放送周期。
- [Bangumi 番组计划](https://bgm.tv/)：封面与评分。
- [AniList](https://anilist.co/)：封面、播出时刻与播出状态。

## License

MIT
