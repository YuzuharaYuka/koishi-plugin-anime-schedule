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
 * 收到 429 / 403 后的冷却时长。
 *
 * 429 是超限封禁、403 是 API 被临时停用，两种情况都沿用已有数据一段时间再试。
 */
export const ANILIST_COOLDOWN_MS = 5 * 60 * 1000

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

/**
 * 插件版本与主页，请求 Bangumi 时用于自报身份。
 *
 * 版本号从 `package.json` 读：单独维护一份字面量必然会在发版时漏更新（它曾停在 1.0.0），
 * 而 `package.json` 一定随包发布，读它不会失效。
 */
export const PLUGIN_VERSION: string = (() => {
  try {
    const pkg = require('../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
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
 *
 * 到期只触发后台补取（`Localizer.kickScoreRefresh()`），不阻塞构建：评分是一张表的
 * 附属信息，为它把整张表推迟十几秒不划算。
 */
export const DEFAULT_SCORE_TTL_HOURS = 24

/**
 * 显示评分所需的最少评价人数。
 *
 * 低于此数不显示评分：新番开播初期样本极少，评分会随样本增加剧烈变化
 * （实测至高之力 1 票时 7.0，156 票时 6.1）。留空优于给出误导性的数字。
 */
export const MIN_SCORE_VOTES = 10

export const LOCALIZE_CACHE_VERSION = 6

/** 本地化缓存最大条目数，超出后按写入时间淘汰最旧的一半 */
export const LOCALIZE_CACHE_MAX_ENTRIES = 5000

/** 取逐集档期时的单页集数上限；超过这个数的长期番不靠集数判断完结 */
export const EPISODE_QUERY_LIMIT = 100

/**
 * 并发检索 Bangumi 的条数上限。
 *
 * Bangumi 没有公开的严格限流，但一次本季表可能有上百部作品。取 6 路：实测 4 路时周表
 * 取详情要 50 秒上下，6 路约省三分之一，仍远低于会让站点限流的密度。
 */
export const LOCALIZE_CONCURRENCY = 6

/**
 * 单次元数据请求的超时（秒），`advanced.requestTimeout` 的默认值。
 *
 * Bangumi 的条目接口是小体积 JSON，正常几百毫秒返回。等满 20 秒基本等价于连接已死，
 * 而一条超时会把整次构建拖住这么久，所以默认压到 10 秒；嫌紧可以自行调大。
 */
export const LOCALIZE_TIMEOUT_SECONDS = 10

/** 并发拉取封面时的并发上限 */
export const COVER_CONCURRENCY = 8

/** 封面下载超时与体积上限，避免个别大图拖垮整次渲染 */
export const COVER_TIMEOUT_MS = 8000
export const COVER_MAX_BYTES = 4 * 1024 * 1024

/** 封面磁盘缓存目录（相对于 ctx.baseDir）与有效期 */
export const COVER_CACHE_DIR = ['data', 'anime-schedule', 'covers']
export const COVER_CACHE_TTL_MS = 21 * 24 * 60 * 60 * 1000
export const COVER_CACHE_MAX_FILES = 1200

/**
 * 内存里保留的解码后封面总量上限（按 RGBA 字节算）。
 *
 * 单张 800px 的封面约 1.8MB，96MB 约合 50 张。插件是常驻进程，封面缓存若无上限会随
 * 渲染过的作品数一路增长；这里只保证「短时间内重复出图不必重新解码」，
 * 超出部分照常回落到磁盘缓存。
 */
export const COVER_MEMORY_MAX_BYTES = 96 * 1024 * 1024

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
 * 图片以文字与细线条为主，块状伪影比在照片上明显。取 100 为无损编码，文字边缘最锐利；
 * 体积比 92 约多三成，可调低换取更小体积。
 */
export const DEFAULT_JPEG_QUALITY = 100

/**
 * 超采样倍数。
 *
 * 画布按「逻辑尺寸 × 该值」建立后在上下文上做等比 `scale`，缩回目标尺寸时由更多采样
 * 得出边缘像素。清晰度主要取决于此：各版面最小字号仅 10~11px，1× 下一个字不足十几个
 * 像素，JPEG 质量再高也无法还原。
 *
 * 3 在密集的封面与小字上收益仍可见；5 是收益递减的上限。
 */
export const DEFAULT_SUPERSAMPLE = 3

/** 超采样倍数的可选上限，与配置项的 `.max()` 保持一致 */
export const MAX_SUPERSAMPLE = 5

/**
 * 每日更新表的日期偏移范围（天）。
 *
 * 配置项的 `.min()/.max()` 与 `normalizeConfig` 的钳制共用这两个值——
 * 两处分开写时极易只改一处，导致「配置页能填、实际被悄悄夹回去」。
 */
export const DAILY_OFFSET_MIN = -7
export const DAILY_OFFSET_MAX = 7

/**
 * 构建结果的复用窗口（毫秒）。
 *
 * 推送遍历频道时每个群都调一次构建，指令层也常被连着问同一张表。这些调用的差别只有
 * 「已订阅」标记，其余部分（场次推算、AniList 状态、Bangumi 详情、封面地址）完全相同，
 * 因此一份结果在窗口内可以重复用，订阅标记事后再按频道注入。
 */
export const BUILD_CACHE_TTL_MS = 5 * 60 * 1000

/** 构建结果同时留存几份（日/深夜/周/季 × 少量偏移），超出丢最早的一份 */
export const BUILD_CACHE_MAX_ENTRIES = 16

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
  padding: 28,
  /** 页眉 / 页脚固定高度 */
  headerHeight: 120,
  footerHeight: 52,

  /** 周历表：七天并排的画布宽度 */
  weekWidth: 1680,
  /**
   * 单日时间轴（每日 / 深夜档）画布宽度。
   *
   * 等于「左边距 + 时刻栏 + 轨道 + 时刻↔卡片间距 + 卡片宽 + 右边距」，不留余量，
   * 使「现在」虚线的终点与卡片右缘重合。
   */
  timelineWidth: 798,
  /** 卡片列表（list 排版）的画布宽度 */
  listWidth: 900,
  /** 本季封面网格的画布宽度，要放得下 10 列 */
  seasonWidth: 1680,

  // ---- 通用行卡片 ----
  /** 行卡片高度：容纳固定的两行标题 + 一行元信息 */
  rowHeight: 104,
  /** 行卡片宽度，窄于画布，避免文字仅占左半、右侧留空 */
  rowCardWidth: 640,
  /** 行卡片之间的间距 */
  rowGap: 8,
  /** 行卡片圆角与内边距 */
  rowRadius: 12,
  rowPadding: 10,
  /** 行卡片封面高度，宽度按 1 : 1.4 推出 */
  mediaHeight: 92,
  /** 封面与文字之间的间距 */
  mediaGap: 14,
  /** 标题行高与固定行数：短标题也占两行，使元信息行在所有卡片上对齐 */
  cardTitleLineHeight: 22,
  cardTitleLines: 2,
  /** 标题块与元信息行之间的间距 */
  cardLineGap: 6,
  /** 封面圆角 */
  mediaRadius: 6,

  // ---- 单日时间轴 ----
  /** 左侧时刻栏宽度（内容左缘到轨道）。需容纳 `现在 18:30` 这类最长时刻文本，否则被画布左缘裁掉 */
  timelineLabelWidth: 70,
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
  /** 列表卡片沿用行卡片高度，两种排版保持一致 */
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
  /**
   * 强调色：时刻、日期、「今天」高亮，以及详情卡的已播集数与峰值柱。
   *
   * 取珊瑚红 `#e26d6d`——比纯红柔和，整张表看下来不刺眼；详情卡的实心块共用它，
   * 于是「已播集数」与列表里的「已订阅」气泡是同一套视觉语言。
   */
  accent: '#e26d6d',
  /** 封面的底色（等比完整显示时留白的那一圈） */
  badge: '#eef1f7',
  /** 强调色的浅色底：软胶囊用 */
  accentSoft: '#fdeceb',
  /** 未播集数 / 禁用态的浅灰底 */
  inert: '#f3f4f6',
  /** 未播集数的文字色，比 muted 更浅，明确表示「还没到」 */
  inertText: '#9ca3af',
  /** 未播集数的描边：仅靠底色时与白色卡片难以区分，需勾出轮廓 */
  inertBorder: '#e5e7eb',
  /** 评分柱的非峰值色 */
  scoreBar: '#fecaca',
  title: '#1f2330',
  body: '#5a6172',
  muted: '#9aa1b1',
  onAccent: '#ffffff',
  /** 评分：橙金色，全插件统一 */
  score: '#e69a3a',
  /** 卡片投影：略深一点，白色卡片才从浅灰背景上立起来 */
  shadow: 'rgba(31, 35, 48, 0.10)',
  /** 封面投影，比卡片投影更轻 */
  coverShadow: 'rgba(0, 0, 0, 0.06)',
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
  /** 已在订阅列表里的作品，条目上的气泡 */
  subscribedBadge: string

  // ── 作品详情卡（`anime.info`）──
  /** 详情卡页脚的数据更新时间 */
  infoUpdated: (moment: string) => string
  /** 连载状态 */
  infoAiring: string
  infoFinished: string
  infoUpcoming: string
  infoUnknown: string
  /** 区块标题 */
  infoSummary: string
  infoProgress: string
  infoScoreBoard: string
  /** 单位与占位文案 */
  infoVotes: string
  infoEpisodes: string
  infoAired: string
  /** 详情里「下一话」的标签 */
  infoNext: string
  /** 拿不到评分或档期时的占位 */
  infoNoScore: string
  infoNoSchedule: string
  /** 搜索结果的标题行 */
  searchHeader: (count: number, keyword: string) => string
  /** 时间轴上「现在」的分界线标签 */
  nowLabel: (clock: string) => string
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
  subscribedBadge: '已订阅',

  infoUpdated: (moment) => `数据更新于 ${moment}`,
  infoAiring: '连载中',
  infoFinished: '已完结',
  infoUpcoming: '未开播',
  infoUnknown: '状态未知',
  infoSummary: '简介',
  infoProgress: '放送进度',
  infoScoreBoard: '评分分布',
  infoVotes: '人评分',
  infoEpisodes: '话',
  infoAired: '已播出',
  infoNext: '下一话',
  infoNoScore: '评分人数不足',
  infoNoSchedule: '暂无逐集档期',
  nowLabel: (clock) => `现在 ${clock}`,
  searchHeader: (count, keyword) => `找到 ${count} 部与 "${keyword}" 相关的作品，用 \`anime.info <序号>\` 看详情、\`anime.sub <序号>\` 订阅:`,
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
  subscribedBadge: '登録済み',

  infoUpdated: (moment) => `データ更新 ${moment}`,
  infoAiring: '放送中',
  infoFinished: '完結',
  infoUpcoming: '放送前',
  infoUnknown: '状態不明',
  infoSummary: 'あらすじ',
  infoProgress: '放送進捗',
  infoScoreBoard: 'スコア分布',
  infoVotes: '人評価',
  infoEpisodes: '話',
  infoAired: '放送済み',
  infoNext: '次回',
  infoNoScore: '評価者不足',
  infoNoSchedule: '話数情報なし',
  nowLabel: (clock) => `現在 ${clock}`,
  searchHeader: (count, keyword) => `「${keyword}」に一致する作品が ${count} 件。\`anime.info <番号>\` で詳細、\`anime.sub <番号>\` で登録:`,
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
  subscribedBadge: 'Subscribed',

  infoUpdated: (moment) => `Updated ${moment}`,
  infoAiring: 'Airing',
  infoFinished: 'Finished',
  infoUpcoming: 'Upcoming',
  infoUnknown: 'Unknown',
  infoSummary: 'Synopsis',
  infoProgress: 'Progress',
  infoScoreBoard: 'Score distribution',
  infoVotes: 'ratings',
  infoEpisodes: 'eps',
  infoAired: 'Aired',
  infoNext: 'Next',
  infoNoScore: 'Too few ratings',
  infoNoSchedule: 'No episode schedule',
  nowLabel: (clock) => `Now ${clock}`,
  searchHeader: (count, keyword) => `Found ${count} titles matching "${keyword}". Use \`anime.info <n>\` for details or \`anime.sub <n>\` to subscribe:`,
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
  notFound: '未找到该作品，可能不在 bangumi-data 索引中。',
} as const

/** 日志里出现的固定短语 */
export const LOG_MESSAGES = {
  cleanupFailed: '清理过期推送记录失败:',
} as const
