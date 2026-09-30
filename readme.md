# koishi-plugin-anime-schedule

[Koishi](https://koishi.chat/) 的番剧更新表与订阅提醒插件。

作品清单来自 [bangumi-data](https://github.com/bangumi-data/bangumi-data)，
排期、封面查询 [AniList](https://anilist.co/)，中文标题、封面与评分取自 [Bangumi](https://bgm.tv/)。

```bash
npm i koishi-plugin-anime-schedule
```

在群聊里执行一次 `anime.on` 后开始接收定时推送。

## 指令

主指令 `anime`（别名 `番剧` `新番`）。

| 指令 | 别名 | 说明 |
| :--- | :--- | :--- |
| `anime.today` | 今日新番 | 今日更新表，`-o -1` 看前一天 |
| `anime.night` | 深夜新番 | 今晚 21:00 至次日 06:00 |
| `anime.week` | 本周新番 | 今天起七天 |
| `anime.season [季度]` | 本季新番 | 本季一览，也可查往季 |
| `anime.search <关键词>` | 番剧搜索 | `-l 5` 限制条数（默认 10） |
| `anime.sub <ID>` | 番剧订阅 | 按 Bangumi 条目 ID 订阅，如 `anime.sub 253104` |
| `anime.remove <ID>` | 取消订阅 | 也接受 `anime.list` 里的序号 |
| `anime.list` | 订阅列表 | 本群订阅的番剧 |
| `anime.clear` | 清空订阅 | 清空本群订阅 |
| `anime.next [天数]` | 追番计划 | 订阅作品未来 1-31 天的排期 |
| `anime.on` / `anime.off` | 开启推送 / 关闭推送 | 本群定时推送开关，可指定类型 |
| `anime.status` | 推送状态 | 本群推送状态 |
| `anime.push <类型>` | 立即推送 | 手动发一次推送 |

`anime.season` 支持 `2026-07`、`2026年7月`、`26夏` 或偏移量 `-1` / `+1`查询往季番剧。
卡片上的 `ID:253104` 与搜索结果里的 `[ID:253104]` 都能直接拿来订阅。

## 说明

- **收录范围**：每日 / 深夜档 / 本周只列还在播的作品；本季表收录该季首播的全部
  TV / WEB 动画（含已播完的），展示首播时间。
- **完结判定**：以 AniList 数据源为准，新番播完后会自动不再出现，无需人工维护。订阅的作品
  播完后也会自动从订阅列表移除。
- **时刻**：按配置的时区显示；以 AniList 记录的时刻为准，查不到时按放送周期推算。
- **去重**：每类推送按「类型 + 目标 + 日期」去重，重启或补发都只发一次。

## 配置

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `timeZone` | `Asia/Shanghai` | 时刻与日期的换算时区 |
| `locale` | `zh-CN` | 界面语言 |
| `push.dailyTime` 等 | 见配置页 | 四种推送各自的开关与时刻 |
| `push.updateLookaheadMinutes` | `30` | 订阅作品提前多少分钟提醒 |
| `content.maxItems` | `0` | 单次推送最多显示多少部，`0` 为不限制 |
| `content.longRunningThreshold` | `0` | 剔除长期连载番的话数阈值，`0` 为不过滤。 |
| `output.format` | `image` | `image` / `text` |
| `output.layout` | `table` | 图片排版：`table` / `list` |
| `localize.titleStyle` | `localized` | `localized` 仅中文 / `both` 中文（日文原名）/ `original` 仅日文原名 |
| `render.jpegQuality` | `100` | 图片编码质量，调低可减小体积 |
| `advanced.debug` | `false` | 输出调试日志 |

## 常见问题

**时间比某个站点的表差 1 小时？**
检查 `timeZone`，日本时间是 UTC+9。

**为什么某部当季新番没有出现？**
本季表只收 TV / WEB 形态，剧场版与 OVA 不计入；也可能尚未被 bangumi-data 收录。

**为什么某部老番出现在今天的更新表里？**
它仍在播出，数据源仍标注为放送中状态。

## 致谢

- [bangumi-data](https://github.com/bangumi-data/bangumi-data)：作品清单与放送周期。
- [Bangumi 番组计划](https://bgm.tv/)：中文标题、封面与评分。
- [AniList](https://anilist.co/)：播出时刻与播出状态。

## License

MIT
