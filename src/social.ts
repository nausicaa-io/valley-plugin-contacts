import type { ReactElement } from 'react'
import { contactIcon, hasContactIcon } from './contactIcons'
import type { Social, SocialLink } from './types'

type IconComp = (p: { className?: string }) => ReactElement

/** Strip a leading `@` and surrounding whitespace from a username. */
function bare(handle: string): string {
  return handle.trim().replace(/^@+/, '').trim()
}

export interface SocialPlatform {
  /** Canonical lowercase id written back to YAML (e.g. `instagram`). */
  id: string
  /** Display label (e.g. `Instagram`). */
  label: string
  /** Extra names/handles that resolve to this platform. */
  aliases: string[]
  /** Build a profile URL from a bare username, or null when not linkable. */
  url: (handle: string) => string | null
}

const PLATFORMS: SocialPlatform[] = [
  {
    id: 'instagram', label: 'Instagram', aliases: ['ig', 'insta'],
    url: (h) => `https://instagram.com/${bare(h)}`
  },
  {
    id: 'x', label: 'X', aliases: ['twitter', 'tweet'],
    url: (h) => `https://x.com/${bare(h)}`
  },
  {
    id: 'linkedin', label: 'LinkedIn', aliases: ['li'],
    url: (h) => {
      const u = bare(h)
      // Accept a full `in/slug` or `company/slug` path, else default to a personal `/in/` profile.
      return /^(in|company|pub|school)\//i.test(u) ? `https://linkedin.com/${u}` : `https://linkedin.com/in/${u}`
    }
  },
  {
    id: 'snapchat', label: 'Snapchat', aliases: ['snap'],
    url: (h) => `https://snapchat.com/add/${bare(h)}`
  },
  {
    id: 'facebook', label: 'Facebook', aliases: ['fb', 'meta'],
    url: (h) => `https://facebook.com/${bare(h)}`
  },
  {
    id: 'tiktok', label: 'TikTok', aliases: [],
    url: (h) => `https://tiktok.com/@${bare(h)}`
  },
  {
    id: 'youtube', label: 'YouTube', aliases: ['yt'],
    url: (h) => `https://youtube.com/@${bare(h)}`
  },
  {
    id: 'github', label: 'GitHub', aliases: ['gh'],
    url: (h) => `https://github.com/${bare(h)}`
  },
  {
    id: 'telegram', label: 'Telegram', aliases: ['tg'],
    url: (h) => `https://t.me/${bare(h)}`
  },
  {
    id: 'whatsapp', label: 'WhatsApp', aliases: ['wa'],
    url: (h) => {
      const digits = h.replace(/[^0-9]/g, '')
      return digits ? `https://wa.me/${digits}` : null
    }
  },
  {
    id: 'threads', label: 'Threads', aliases: [],
    url: (h) => `https://threads.net/@${bare(h)}`
  },
  {
    id: 'reddit', label: 'Reddit', aliases: [],
    url: (h) => `https://reddit.com/user/${bare(h).replace(/^u\//i, '')}`
  },
  {
    id: 'discord', label: 'Discord', aliases: [],
    url: () => null
  },
  {
    id: 'twitch', label: 'Twitch', aliases: [],
    url: (h) => `https://twitch.tv/${bare(h)}`
  },
  {
    id: 'pinterest', label: 'Pinterest', aliases: [],
    url: (h) => `https://pinterest.com/${bare(h)}`
  },
  {
    id: 'spotify', label: 'Spotify', aliases: [],
    url: (h) => `https://open.spotify.com/user/${bare(h)}`
  },
  {
    id: 'mastodon', label: 'Mastodon', aliases: [],
    url: (h) => {
      // Fediverse handle: `@user@instance` or `user@instance` -> https://instance/@user
      const m = bare(h).match(/^([^@\s]+)@([^@\s]+)$/)
      return m ? `https://${m[2]}/@${m[1]}` : null
    }
  },
  {
    id: 'bluesky', label: 'Bluesky', aliases: ['bsky'],
    url: (h) => `https://bsky.app/profile/${bare(h)}`
  },
  {
    id: 'wechat', label: 'WeChat', aliases: ['weixin'],
    url: () => null
  },
  {
    id: 'weibo', label: 'Weibo', aliases: ['sinaweibo', 'sina'],
    url: (h) => `https://weibo.com/n/${bare(h)}`
  },
  {
    id: 'qq', label: 'QQ', aliases: ['tencentqq'],
    url: () => null
  },
  {
    id: 'qzone', label: 'QQ Zone', aliases: ['qqzone'],
    url: (h) => { const d = h.replace(/[^0-9]/g, ''); return d ? `https://user.qzone.qq.com/${d}` : null }
  },
  {
    id: 'bilibili', label: 'Bilibili', aliases: ['bili'],
    url: (h) => { const d = h.replace(/[^0-9]/g, ''); return d ? `https://space.bilibili.com/${d}` : null }
  },
  {
    id: 'xiaohongshu', label: 'Xiaohongshu', aliases: ['rednote', 'littleredbook'],
    url: (h) => `https://xiaohongshu.com/user/profile/${bare(h)}`
  },
  {
    id: 'zhihu', label: 'Zhihu', aliases: [],
    url: (h) => `https://zhihu.com/people/${bare(h)}`
  },
  {
    id: 'kuaishou', label: 'Kuaishou', aliases: [],
    url: (h) => `https://kuaishou.com/profile/${bare(h)}`
  },
  {
    id: 'douban', label: 'Douban', aliases: [],
    url: (h) => `https://douban.com/people/${bare(h)}`
  },
  {
    id: 'vk', label: 'VK', aliases: ['vkontakte'],
    url: (h) => `https://vk.com/${bare(h)}`
  },
  {
    id: 'odnoklassniki', label: 'Odnoklassniki', aliases: ['ok'],
    url: (h) => `https://ok.ru/${bare(h)}`
  },
  {
    id: 'viber', label: 'Viber', aliases: [],
    url: () => null
  },
  {
    id: 'line', label: 'LINE', aliases: [],
    url: (h) => `https://line.me/ti/p/~${bare(h)}`
  },
  {
    id: 'kakaotalk', label: 'KakaoTalk', aliases: ['kakao'],
    url: () => null
  },
  {
    id: 'signal', label: 'Signal', aliases: [],
    url: (h) => { const d = h.replace(/[^0-9]/g, ''); return d ? `https://signal.me/#p/+${d}` : null }
  },
  {
    id: 'sharechat', label: 'ShareChat', aliases: [],
    url: (h) => `https://sharechat.com/profile/${bare(h)}`
  },
  {
    id: 'moj', label: 'Moj', aliases: [],
    url: () => null
  },
  {
    id: 'josh', label: 'Josh', aliases: [],
    url: () => null
  }
]

const BY_KEY = new Map<string, SocialPlatform>()
for (const p of PLATFORMS) {
  BY_KEY.set(p.id, p)
  BY_KEY.set(p.label.toLowerCase(), p)
  for (const a of p.aliases) BY_KEY.set(a, p)
}

/** Match a free-text platform name onto a known platform (id / label / alias). */
export function matchPlatform(name: string | undefined): SocialPlatform | null {
  const key = (name ?? '').trim().toLowerCase()
  return key ? BY_KEY.get(key) ?? null : null
}

/** Canonical lowercase platform id for YAML (`Instagram` -> `instagram`), or the trimmed input. */
export function canonicalPlatform(name: string | undefined): string {
  return matchPlatform(name)?.id ?? (name ?? '').trim().toLowerCase()
}

/** The default URL template (with a `{}` username placeholder) for each platform. */
const DEFAULT_TEMPLATES: Record<string, string> = {
  instagram: 'https://instagram.com/{}',
  x: 'https://x.com/{}',
  linkedin: 'https://linkedin.com/in/{}',
  snapchat: 'https://snapchat.com/add/{}',
  facebook: 'https://facebook.com/{}',
  tiktok: 'https://tiktok.com/@{}',
  youtube: 'https://youtube.com/@{}',
  github: 'https://github.com/{}',
  telegram: 'https://t.me/{}',
  whatsapp: 'https://wa.me/{}',
  threads: 'https://threads.net/@{}',
  reddit: 'https://reddit.com/user/{}',
  discord: '',
  twitch: 'https://twitch.tv/{}',
  pinterest: 'https://pinterest.com/{}',
  spotify: 'https://open.spotify.com/user/{}',
  mastodon: '',
  bluesky: 'https://bsky.app/profile/{}',
  wechat: '',
  weibo: 'https://weibo.com/n/{}',
  qq: '',
  qzone: 'https://user.qzone.qq.com/{}',
  bilibili: 'https://space.bilibili.com/{}',
  xiaohongshu: 'https://xiaohongshu.com/user/profile/{}',
  zhihu: 'https://zhihu.com/people/{}',
  kuaishou: 'https://kuaishou.com/profile/{}',
  douban: 'https://douban.com/people/{}',
  vk: 'https://vk.com/{}',
  odnoklassniki: 'https://ok.ru/{}',
  viber: '',
  line: 'https://line.me/ti/p/~{}',
  kakaotalk: '',
  signal: '',
  sharechat: 'https://sharechat.com/profile/{}',
  moj: '',
  josh: ''
}

/** The platforms seeded into Settings on first run (label + editable URL template). */
export function defaultSocialLinks(): SocialLink[] {
  return PLATFORMS.map((p) => ({ id: p.id, label: p.label, url: DEFAULT_TEMPLATES[p.id] ?? '' }))
}

export function iconForPlatform(name: string | undefined, icon?: string): IconComp {
  if (icon && hasContactIcon(icon)) return contactIcon(icon)
  if (hasContactIcon(name)) return contactIcon(name)
  return contactIcon(matchPlatform(name)?.label)
}

/**
 * Build a profile URL from a template and a username: `{}` / `{username}` /
 * `{handle}` are substituted; a template with no placeholder is treated as a
 * base URL the username is appended to. Empty template -> not linkable.
 */
export function buildSocialUrl(template: string, username: string): string | null {
  const t = template.trim()
  const u = bare(username)
  if (!t || !u) return null
  if (/\{(username|handle|)\}/.test(t)) return t.replace(/\{(username|handle|)\}/g, u)
  return t.replace(/\/+$/, '') + '/' + u
}

function findLink(links: readonly SocialLink[] | undefined, rawName: string | undefined, platform: SocialPlatform | null): SocialLink | null {
  if (!links || !links.length) return null
  const key = (rawName ?? '').trim().toLowerCase()
  const pid = platform?.id
  return links.find((l) => (pid && l.id === pid) || l.id.toLowerCase() === key || l.label.toLowerCase() === key) ?? null
}

export interface ResolvedSocial {
  label: string
  icon: IconComp
  /** Openable URL (explicit `url:` wins, else derived from the settings template), or null. */
  href: string | null
  /** What to show as the row's primary text. */
  display: string
  known: boolean
}

/**
 * Resolve a stored social entry into label + icon + openable link. The URL comes
 * from the matching Settings link's template (`links`), or a built-in fallback.
 */
export function resolveSocial(s: Social, links?: readonly SocialLink[]): ResolvedSocial {
  const platform = matchPlatform(s.platform)
  const handle = (s.handle ?? '').trim()
  const explicit = (s.url ?? '').trim()
  const link = findLink(links, s.platform, platform)
  let href = explicit || null
  if (!href && link && handle) href = buildSocialUrl(link.url, handle)
  if (!href && !link && platform && handle) href = platform.url(handle)
  if (!href && !platform && !link && /^https?:\/\//i.test(handle)) href = handle
  return {
    label: link?.label ?? platform?.label ?? (s.platform || 'Link').trim(),
    icon: iconForPlatform(link?.label ?? s.platform, link?.icon),
    href,
    display: handle || explicit || (s.platform ?? '').trim(),
    known: Boolean(platform || link)
  }
}
