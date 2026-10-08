import type { DigestKind, PluginLocale } from './types'

/** 插件名，同时作为日志前缀与 User-Agent 主体 */
export const PLUGIN_NAME = 'anime-schedule'

/** Bangumi API 主机 */
export const BANGUMI_API_HOST = 'https://api.bgm.tv'

/**
 * AniList GraphQL 接口。
 *
 * 用于查询「这部番是否还在播」：它直接给出 `status`（FINISHED / RELEASING）与 `endDate`，
 * 而 bangumi-data 自带 `aniList` 的条目 ID，可以按 ID 精确查询、避开标题匹配歧义。
 */
export const ANILIST_API_URL = 'https://graphql.anilist.co'

/** 单次 GraphQL 请求最多查多少个条目 */
export const ANILIST_BATCH_SIZE = 50

/**
 * 两次 AniList 请求之间的最小间隔（毫秒）。
 *
 * 官方限制 90 次/分钟（实测响应头为 30），另有突发限流。留出 1.2 秒间隔后
 * 相当于最多 50 次/分钟，既不会触发突发限流，也远低于上限。
 */
export const ANILIST_MIN_INTERVAL_MS = 1200

/**
 * bangumi-data 索引。
 *
 * 数据默认来自 npm 依赖包 `bangumi-data`（`main` 指向 `dist/data.json`），
 * 随插件一起安装、无需联网；下面这些地址只在依赖包缺失时才作为回退。
 * 仓库: https://github.com/bangumi-data/bangumi-data
 */
export const BANGUMI_DATA_FALLBACK_URLS = [
  'https://cdn.jsdelivr.net/npm/bangumi-data@latest/dist/data.json',
  'https://unpkg.com/bangumi-data@latest/dist/data.json',
  'https://raw.githubusercontent.com/bangumi-data/bangumi-data/master/dist/data.json',
]
export const BANGUMI_DATA_FILE = 'bangumi-data.json'

/** bangumi-data 回退缓存的目录（相对于 ctx.baseDir），与本地化缓存放在一起 */
export const DATA_DIR = ['data', 'anime-schedule']

/** 插件版本与主页，请求 Bangumi 时用于自报身份 */
export const PLUGIN_VERSION = '1.0.0'
export const PLUGIN_HOMEPAGE = 'https://github.com/YuzuharaYuka/koishi-plugin-anime-schedule'

/**
 * 请求 Bangumi 时使用的 User-Agent。
 * Bangumi 要求客户端自报身份，形如 `AppName/version (+主页)`。
 */
export function buildUserAgent(): string {
  return `${PLUGIN_NAME}/${PLUGIN_VERSION} (+${PLUGIN_HOMEPAGE})`
}

/** 各类推送的展示名，用于日志、合并转发标题与开关回复 */
export const DIGEST_LABELS: Record<DigestKind, string> = {
  daily: '每日更新表',
  night: '深夜档',
  weekly: '本周更新表',
  season: '本季新番表',
  sub: '番剧订阅',
}

/** 卡片列表排版绘制的卡片数上限，避免条目异常多时图片长度失控 */
export const IMAGE_MAX_CARDS = 200

/** 列表排版超过这个数量就折成两栏，避免长图过长 */
export const IMAGE_LIST_TWO_COLUMN_AT = 26

/**
 * 「深夜番」的判定：本地时间 0 点到 6 点算作前一日的深夜档。
 *
 * 与 `DigestService` 的深夜档窗口终点（次日 06:00）保持一致——两处都表示「凌晨这一段的结束时刻」，
 * 改一处时另一处也要跟着改。这里的用途是统计与文案（`finish()` 里的「其中 N 部为深夜档」、
 * 时间轴的 24 小时制续写），不是窗口本身。
 */
export const LATE_NIGHT_END_HOUR = 6

/** 本地化缓存的落盘文件名 */
export const LOCALIZE_CACHE_FILE = 'localize-cache.json'

/**
 * 本地化缓存的结构版本。
 *
 * 条目字段变化时必须递增：版本不匹配会整份重建，避免旧条目缺少新字段
 * （例如判断完结所需的 `lastAirDate`）导致逻辑静默失效。
 *
 * v2：新增 `totalEpisodes` 与 `airDate`；旧缓存缺这两个字段，不丢弃会一直重复请求。
 * v6：新增 `hasEpisodeTimes`。逐集档期不再是每条必取，需要靠它区分
 *     「没取过逐集档期」与「取过但没有集数日期」。
 */
/**
 * 评分与评价人数的缓存小时数。
 *
 * 比标题封面的 cacheTtlDays 短得多：新番开播头几周评分天天在变，样本量从个位数
 * 涨到几百，用 30 天缓存会一直显示「只有十几个人投票」时的噪声值。
 */
export const DEFAULT_SCORE_TTL_HOURS = 24

/**
 * 显示评分所需的最少评价人数。
 *
 * 低于这个数就不显示评分：新番刚开播时可能只有一两个人投票，那个数字会随着样本增加
 * 剧烈变化（实测至高之力 1 票时是 7.0，156 票时是 6.1）。宁可留空，也不要给读者一个
 * 会误导人的数字。
 */
export const MIN_SCORE_VOTES = 10

export const LOCALIZE_CACHE_VERSION = 6

/** 本地化缓存最大条目数，超出后按写入时间淘汰最旧的一半 */
export const LOCALIZE_CACHE_MAX_ENTRIES = 5000

/** 取逐集档期时的单页集数上限；超过这个数的长期番不靠集数判断完结 */
export const EPISODE_QUERY_LIMIT = 100

/**
 * 并发检索 Bangumi 的条数上限。
 * Bangumi 没有公开的严格限流，但一次本季表可能有上百部作品，
 * 4 路并发已能把原本串行的等待时间压到 1/4，同时不至于触发风控。
 */
export const LOCALIZE_CONCURRENCY = 4

/** 并发拉取封面时的并发上限 */
export const COVER_CONCURRENCY = 8

/** 封面下载超时与体积上限，避免个别大图拖垮整次渲染 */
export const COVER_TIMEOUT_MS = 8000
export const COVER_MAX_BYTES = 4 * 1024 * 1024

/** 封面磁盘缓存目录（相对于 ctx.baseDir）与有效期 */
export const COVER_CACHE_DIR = ['data', 'anime-schedule', 'covers']
export const COVER_CACHE_TTL_MS = 21 * 24 * 60 * 60 * 1000
export const COVER_CACHE_MAX_FILES = 1200

/** 图片渲染用的字体候选，按平台常见路径排列，找不到时回退到运行环境默认字体 */
export const FONT_CANDIDATES: string[] = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyh.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
]

/** 加粗字体候选，找不到时由绘制层用描边模拟粗体 */
export const BOLD_FONT_CANDIDATES: string[] = [
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/Dengb.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
]

/**
 * JPEG 编码质量。
 *
 * 时间表以文字与细线条为主，JPEG 的块状伪影在这种内容上比照片里明显得多。取 100
 * 是**无损**编码，文字边缘最锐利；体积比 92 大约多三成，但一张周表也就一兆出头，
 * 不值得为省这点流量牺牲清晰度。想压体积可以调低。
 */
export const DEFAULT_JPEG_QUALITY = 100
/** 注册到 canvas 的字体族名，与 config.render.fontFamily 的默认值保持一致 */
export const DEFAULT_FONT_FAMILY = 'Anime Schedule Sans'

/**
 * 图片版式常量。
 *
 * 版式遵循同一套规则，所有版面共享它，避免各处各写一套数字：
 * - **页眉**：左侧强调条 + 标题，其下是副标题，右上角是统计与时区，固定高度 120。
 * - **页脚**：清一色 bottom 对齐，只写数据来源。
 * - **卡片**：内容一律**居左**排列；封面、标题、次要信息的竖直位置固定，
 *   与文字长短无关，因此整张图的每一行都对齐在同样的基线上。
 * - **封面**：统一 `媒体高 × 1.4` 的竖版比例，等比完整显示，不裁切。
 */
export const IMAGE_LAYOUT = {
  /** 统一外边距 */
  padding: 24,
  /** 页眉 / 页脚固定高度 */
  headerHeight: 120,
  footerHeight: 52,

  /** 周历表：七天并排的画布宽度 */
  weekWidth: 1680,
  /** 单日时间轴（每日 / 深夜档）的画布宽度 */
  timelineWidth: 900,
  /** 卡片列表（list 排版）的画布宽度 */
  listWidth: 900,
  /** 本季封面网格的画布宽度，要放得下 10 列 */
  seasonWidth: 1680,

  // ---- 通用行卡片 ----
  /** 行卡片高度（每日 / 列表排版）。容纳「标题 + 时刻 + 集数 + ID + 评分」五行 */
  rowHeight: 112,
  /** 行卡片之间的间距 */
  rowGap: 8,
  /** 行卡片圆角与内边距 */
  rowRadius: 12,
  rowPadding: 12,
  /** 行卡片封面高度，宽度按 1 : 1.4 推出 */
  mediaHeight: 82,
  /** 封面与文字之间的间距 */
  mediaGap: 14,
  /** 卡片文字行间距。五行内容靠它撑开节奏，太小会挤成一团 */
  cardLineGap: 6,
  /** 封面圆角 */
  mediaRadius: 6,

  // ---- 单日时间轴 ----
  /** 时间轴轨道相对左边距的位置 */
  timelineSpine: 50,
  /** 轨道圆点半径 */
  timelineDot: 4,
  /** 时刻文字与轨道之间的间距 */
  timelineTimeGap: 12,
  /** 时刻文字与封面之间的间距 */
  timelineCardGap: 20,
  /** 日期节点高度（深夜档的「今晚 / 次日凌晨」） */
  timelineDayHeaderHeight: 56,
  /** 时间轴主线颜色 */
  timelineLine: '#f6d2cc',

  // ---- 周历表 ----
  /** 七日列之间的间距与整张卡的内边距 */
  weekColumnGap: 18,
  weekCardPadding: 16,
  /** 周历表列头高度 */
  weekHeaderHeight: 92,
  /** 周历表条目高度、行距与标题行数 */
  weekRowHeight: 104,
  weekRowGap: 8,
  weekTitleLines: 2,
  weekTitleLineHeight: 18,
  /** 周历表条目内的封面高度（与三行文字齐高，保持 1 : 1.4 比例不再被压扁） */
  weekMediaHeight: 82,

  // ---- 卡片列表 ----
  /** 列表卡片高度（与行卡片一致，两种排版观感统一） */
  cardHeight: 112,
  cardGap: 12,
  /** 两栏之间的间距 */
  cardColumnGap: 14,
  /** 分组标题占用的高度 */
  sectionHeaderHeight: 34,

  // ---- 本季封面网格 ----
  /** 每行的番剧数量 */
  seasonColumns: 10,
  /** 网格列间距与行间距 */
  seasonColumnGap: 20,
  seasonRowGap: 18,
  /** 网格卡片内边距与卡片高度。封面盒高即卡片高减去上下内边距与元信息高度 */
  seasonPadding: 8,
  seasonCardHeight: 292,
  /** 标题行数与行高（固定两行，保证首播时间、ID 与评分在同一基线） */
  seasonTitleLines: 2,
  seasonTitleLineHeight: 19,
  /** 首播时间 / 条目 ID / 评分三行共用的行高 */
  gridMetaLineHeight: 16,
  /** 封面宽高比（1 : 1.4 的竖版，与 Bangumi 原图一致） */
  seasonCoverRatio: 0.72,
}

/** 时间表配色，全插件共用一套色板 */
export const IMAGE_THEME = {
  background: '#f4f5f8',
  surface: '#ffffff',
  cardBorder: '#e6e8ef',
  divider: '#eef0f5',
  /** 强调色：时刻、日期与「今天」高亮 */
  accent: '#f6665f',
  /** 封面的底色（等比完整显示时留白的那一圈） */
  badge: '#eef1f7',
  title: '#1f2330',
  body: '#5a6172',
  muted: '#9aa1b1',
  onAccent: '#ffffff',
  score: '#f0913c',
  /** 卡片投影：略深一点，白色卡片才从浅灰背景上立起来 */
  shadow: 'rgba(31, 35, 48, 0.10)',
}

/**
 * 面向用户的文本。默认中文，`ja-JP` / `en-US` 覆盖展示层最常读到的句子，
 * 未覆盖的键回退到中文，保证任何语言下都不会出现空文案。
 *
 * 日期文案由 `formatDayLabel` 按语言格式化，不再硬编码在表格里。
 */
export interface Messages {
  weekdayNames: string[]
  dailyHeader: (date: string) => string
  nightHeader: (date: string) => string
  weeklyHeader: (start: string, end: string) => string
  seasonHeader: (label: string) => string
  subHeader: (count: number) => string
  emptyDaily: string
  emptyNight: string
  emptyWeekly: string
  emptySeason: string
  emptySub: string
  /** 有订阅、但今天都没有播出时的提示 */
  noAiringSub: (count: number) => string
  /** 每日表与订阅表里「当天」那一段的标题 */
  daytimeGroup: string
  /** 深夜档推送里「今晚 21:00 起」那一段的标题 */
  tonightGroup: (date: string) => string
  /** 订阅表里「次日凌晨」那一段的标题 */
  tomorrowDawnGroup: (date: string) => string
  seasonLabel: (year: number, month: number) => string
  countUnit: string
  /** 完整集数文案，例如 `第 5 话` */
  episodeUnit: (count: number) => string
  /** 时间表排版里的短集数文本，例如 `#5` */
  episodeShort: (count: number) => string
  summaryOf: (total: number, lateNight: number) => string
  truncated: (shown: number, total: number) => string
  footer: string
  /** 周历表表头的日期区间，例如 `9月21日 - 9月27日`；两端已由 formatDayLabel 本地化 */
  rangeLabel: (start: string, end: string) => string
  /** 今天的日期列角标 */
  todayBadge: string
  /** 已在订阅列表里的作品，条目上的气泡 */
  subscribedBadge: string
  /** 日期列超出上限时的提示 */
  moreItems: (count: number) => string
}

const ZH_CN: Messages = {
  weekdayNames: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  dailyHeader: (date) => `今日番剧更新 (${date})`,
  nightHeader: (date) => `今晚深夜档 (${date})`,
  weeklyHeader: (start, end) => `本周番剧更新 (${start} 至 ${end})`,
  seasonHeader: (label) => `${label} 新番表`,
  subHeader: (count) => `订阅番剧更新 (共 ${count} 部)`,
  emptyDaily: '今天没有符合条件的番剧播出。',
  emptyNight: '今晚没有符合条件的深夜档节目。',
  emptyWeekly: '本周没有符合条件的番剧播出。',
  emptySeason: '本季暂时没有符合条件的番剧。',
  emptySub: '本群还没有订阅任何番剧，使用 `anime.sub <ID>` 添加。',
  noAiringSub: (count) => `本群订阅的 ${count} 部作品今天都没有播出。`,
  daytimeGroup: '今日播出',
  tonightGroup: (date) => `今晚 (${date} 21:00 起)`,
  tomorrowDawnGroup: (date) => `次日凌晨 (${date})`,
  seasonLabel: (year, month) => `${year} 年 ${month} 月新番`,
  countUnit: '部',
  episodeUnit: (count) => `第 ${count} 话`,
  episodeShort: (count) => `#${count}`,
  summaryOf: (total, lateNight) => `共 ${total} 部作品${lateNight ? `，其中 ${lateNight} 部为深夜档` : ''}`,
  truncated: (shown, total) => `仅显示前 ${shown} 部，其余 ${total - shown} 部请使用指令按需查询。`,
  footer: '数据来源: bangumi-data / Bangumi',
  rangeLabel: (start, end) => `${start} - ${end}`,
  todayBadge: '今天',
  subscribedBadge: '已订阅',
  moreItems: (count) => `还有 ${count} 部`,
}

const JA_JP: Messages = {
  ...ZH_CN,
  weekdayNames: ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'],
  dailyHeader: (date) => `本日の番組表 (${date})`,
  nightHeader: (date) => `今夜の深夜枠 (${date})`,
  weeklyHeader: (start, end) => `今週の番組表 (${start} 〜 ${end})`,
  seasonHeader: (label) => `${label} 新作アニメ`,
  subHeader: (count) => `登録作品の更新 (全 ${count} 作品)`,
  emptyDaily: '本日は条件に合う番組がありません。',
  emptyNight: '今夜は条件に合う深夜枠がありません。',
  emptyWeekly: '今週は条件に合う番組がありません。',
  emptySeason: '今期は条件に合う作品がありません。',
  emptySub: 'このチャンネルには登録作品がありません。`anime.sub <ID>` で追加できます。',
  noAiringSub: (count) => `登録中の ${count} 作品は本日放送がありません。`,
  daytimeGroup: '本日の放送',
  tonightGroup: (date) => `今夜 (${date} 21:00 以降)`,
  tomorrowDawnGroup: (date) => `翌日未明 (${date})`,
  seasonLabel: (year, month) => `${year}年${month}月期`,
  countUnit: '作品',
  episodeUnit: (count) => `第${count}話`,
  episodeShort: (count) => `#${count}`,
  summaryOf: (total, lateNight) => `全 ${total} 作品${lateNight ? `、うち深夜枠 ${lateNight} 作品` : ''}`,
  truncated: (shown, total) => `先頭 ${shown} 作品のみ表示しています (残り ${total - shown} 作品)。`,
  footer: 'データ提供: bangumi-data / Bangumi',
  rangeLabel: (start, end) => `${start} 〜 ${end}`,
  todayBadge: '今日',
  subscribedBadge: '登録済み',
  moreItems: (count) => `他 ${count} 作品`,
}

const EN_US: Messages = {
  ...ZH_CN,
  weekdayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  dailyHeader: (date) => `Airing today (${date})`,
  nightHeader: (date) => `Late night tonight (${date})`,
  weeklyHeader: (start, end) => `Airing this week (${start} to ${end})`,
  seasonHeader: (label) => `${label} lineup`,
  subHeader: (count) => `Subscribed titles (${count})`,
  emptyDaily: 'No matching programs air today.',
  emptyNight: 'No late-night programs tonight.',
  emptyWeekly: 'No matching programs air this week.',
  emptySeason: 'No matching titles this season.',
  emptySub: 'No subscription in this channel yet. Add one with `anime.sub <ID>`.',
  noAiringSub: (count) => `None of your ${count} subscribed titles air today.`,
  daytimeGroup: 'Airing today',
  tonightGroup: (date) => `Tonight (from 21:00, ${date})`,
  tomorrowDawnGroup: (date) => `After midnight (${date})`,
  seasonLabel: (year, month) => `${year}-${String(month).padStart(2, '0')} season`,
  countUnit: 'titles',
  episodeUnit: (count) => `Episode ${count}`,
  episodeShort: (count) => `#${count}`,
  summaryOf: (total, lateNight) => `${total} titles${lateNight ? `, ${lateNight} of them late night` : ''}`,
  truncated: (shown, total) => `Showing first ${shown} of ${total} titles.`,
  footer: 'Data: bangumi-data / Bangumi',
  rangeLabel: (start, end) => `${start} - ${end}`,
  todayBadge: 'Today',
  subscribedBadge: 'Subscribed',
  moreItems: (count) => `+${count} more`,
}

export const MESSAGES: Record<PluginLocale, Messages> = {
  'zh-CN': ZH_CN,
  'ja-JP': JA_JP,
  'en-US': EN_US,
}

export function getMessages(locale: PluginLocale): Messages {
  return MESSAGES[locale] ?? ZH_CN
}

/** 交互回复：完整句，结尾带句号 */
export const RESPONSES = {
  needGuild: '请在群聊中使用此指令。',
  invalidKind: (value: string) => `无效的推送类型: ${value}，可选值为 daily、night、weekly、season。`,
  invalidDigest: (value: string) => `无效的推送类型: ${value}，可选值为 daily、night、weekly、season。`,
  invalidTid: (value: string) => `无效的作品 ID: ${value}，请使用 Bangumi 条目 ID（如 \`253104\`）或搜索结果中的序号。`,
  invalidIndex: (value: string) => `无效的序号: ${value}，请使用订阅列表中的序号或作品 ID。`,
  noSubscription: '本群还没有订阅任何番剧，先使用 `anime.search <关键词>` 找到作品，再用 `anime.sub <ID>` 订阅。',
  subscribeLimit: (limit: number) => `本群订阅数量已达上限 (${limit} 部)，请先取消部分订阅。`,
  alreadySubscribed: (title: string) => `已经订阅过 ${title} 了。`,
  subscribeFailed: '订阅失败，请稍后重试或检查后台日志。',
  databaseFailed: '数据库操作失败，请检查后台日志。',
  renderFailed: '图片渲染失败，已改用文本发送。',
  emptySearch: (keyword: string) => `未找到与 "${keyword}" 相关的作品，请尝试使用日文原名或更简短的关键词。`,
  notFound: '未找到该作品，它可能不在 bangumi-data 索引里。',
} as const

/** 日志里出现的固定短语 */
export const LOG_MESSAGES = {
  cleanupFailed: '清理过期推送记录失败:',
} as const
