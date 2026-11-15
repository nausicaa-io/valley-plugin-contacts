import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { disposeStore } from '../src/store'
import { Settings } from '../src/Settings'
import { ContactForm } from '../src/ContactForm'
import { canonicalPlatform, defaultSocialLinks, iconForPlatform, resolveSocial } from '../src/social'
import { contactIcon, refreshContactIcons, sanitizeContactSvg, hasContactIcon } from '../src/contactIcons'
import { getSettings } from '../src/data'
import type { SocialLink } from '../src/types'
import { readContactIcons } from '../src/backend/icons'

declare const CONTACT_ICON_SVGS: Record<string, string>

const V1 = ['instagram', 'x', 'linkedin', 'snapchat', 'facebook', 'tiktok', 'youtube', 'github',
  'telegram', 'whatsapp', 'threads', 'reddit', 'discord', 'twitch', 'pinterest', 'spotify',
  'mastodon', 'bluesky']

function link(id: string, label: string, url = ''): SocialLink {
  return { id, label, url }
}

function setup(socials?: SocialLink[]): ReturnType<typeof createMockValleyApi> {
  const mock = createMockValleyApi({
    manifest: { id: 'contacts' },
    realm: { path: '/mock/realm', name: 'mock', displayName: 'mock' },
    settings: socials ? { contactsRoot: 'Meadow/Orbit', socials } : { contactsRoot: 'Meadow/Orbit' }
  })
  // The backend reads `.valley/assets/icons/contacts-icon/`; here it answers with the bundled set.
  mock.api.backend.call = vi.fn(async () => ({ icons: CONTACT_ICON_SVGS })) as never
  initRuntime(mock.api)
  return mock
}

async function setupWithIcons(socials?: SocialLink[]): Promise<ReturnType<typeof createMockValleyApi>> {
  const mock = setup(socials)
  await act(async () => refreshContactIcons(mock.api))
  return mock
}

afterEach(() => {
  cleanup()
  disposeStore()
})

describe('social platform registry', () => {
  it('offers the Chinese, Russian and Indian platforms beside the ones it always had', () => {
    setup()
    const ids = defaultSocialLinks().map((entry) => entry.id)

    for (const id of V1) expect(ids).toContain(id)
    // China · Russia · India — the regions the built-in list had no answer for.
    expect(ids).toEqual(expect.arrayContaining(['wechat', 'weibo', 'qq', 'qzone', 'bilibili', 'xiaohongshu', 'zhihu', 'kuaishou', 'douban']))
    expect(ids).toEqual(expect.arrayContaining(['vk', 'odnoklassniki', 'viber']))
    expect(ids).toEqual(expect.arrayContaining(['sharechat', 'moj', 'josh']))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resolves the new platforms by alias and builds their profile links', () => {
    setup()
    expect(canonicalPlatform('WeChat')).toBe('wechat')
    expect(canonicalPlatform('weixin')).toBe('wechat')
    expect(canonicalPlatform('VKontakte')).toBe('vk')
    expect(canonicalPlatform('ok')).toBe('odnoklassniki')

    const links = defaultSocialLinks()
    expect(resolveSocial({ platform: 'vk', handle: 'otter' }, links).href).toBe('https://vk.com/otter')
    expect(resolveSocial({ platform: 'weibo', handle: '@fern' }, links).href).toBe('https://weibo.com/n/fern')
    expect(resolveSocial({ platform: 'bilibili', handle: '12345' }, links).href).toBe('https://space.bilibili.com/12345')
    // WeChat has no public profile URL — the row still renders, just unlinked.
    expect(resolveSocial({ platform: 'wechat', handle: 'fern' }, links).href).toBeNull()
    expect(resolveSocial({ platform: 'wechat', handle: 'fern' }, links).label).toBe('WeChat')
  })

  it('matches SVG filenames and aliases and uses the generic icon for unknown names', async () => {
    await setupWithIcons()
    expect(iconForPlatform(' Instagram ')).toBe(contactIcon('instagram'))
    expect(iconForPlatform('QQ Zone')).toBe(contactIcon('qq-zone'))
    expect(iconForPlatform('qqzone')).toBe(contactIcon('qq-zone'))
    expect(iconForPlatform('twitter')).toBe(contactIcon('x'))
    expect(iconForPlatform('unknown')).toBe(contactIcon('social'))
    expect(resolveSocial({}, []).icon).toBe(contactIcon('social'))
    const { container } = render(React.createElement(iconForPlatform('Instagram')))
    expect(container.querySelector('svg path')?.getAttribute('d')).toBeTruthy()
  })

  it('uses a saved icon override and falls back to the name if its file is missing', async () => {
    await setupWithIcons()
    const links = [{ ...link('custom', 'My platform'), icon: 'github' }]
    expect(resolveSocial({ platform: 'custom' }, links).icon).toBe(contactIcon('github'))
    expect(iconForPlatform('Instagram', 'missing')).toBe(contactIcon('instagram'))
  })

})

describe('social platform settings list', () => {
  it('reorders the registry from the keyboard and writes the new order', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram'), link('wechat', 'WeChat'), link('vk', 'VK')])
    render(<Settings section="social" />)

    const grips = screen.getAllByTitle('Drag to reorder')
    expect(grips).toHaveLength(3)

    fireEvent.keyDown(grips[0], { key: 'ArrowDown' })

    expect((mock.api.settings.get().socials as SocialLink[]).map((entry) => entry.id))
      .toEqual(['wechat', 'instagram', 'vk'])
  })

  it('persists a manual SVG selection across remounts and can return to automatic matching', async () => {
    const mock = await setupWithIcons([link('custom', 'My platform')])
    const view = render(<Settings section="social" />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose icon for My platform' }))
    const picker = render(<>{mock.popovers[0].node}</>)
    fireEvent.change(picker.getByRole('textbox', { name: 'Search icons' }), { target: { value: 'github' } })
    fireEvent.click(picker.getByRole('button', { name: 'github.svg' }))
    picker.unmount()
    expect(getSettings().socials[0].icon).toBe('github')
    expect(resolveSocial({ platform: 'custom' }, getSettings().socials).icon).toBe(contactIcon('github'))
    view.unmount()
    render(<Settings section="social" />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose icon for My platform' }))
    const reopened = render(<>{mock.popovers[1].node}</>)
    expect(reopened.getByRole('button', { name: 'github.svg' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(reopened.getByRole('button', { name: 'Match platform name automatically' }))
    reopened.unmount()
    expect(getSettings().socials[0].icon).toBeUndefined()
  })

  it('matches a renamed platform by its label instead of its original id', async () => {
    await setupWithIcons([{ ...link('instagram', 'GitHub'), icon: undefined }])
    expect(resolveSocial({ platform: 'instagram' }, getSettings().socials).icon).toBe(contactIcon('github'))
  })

  it('keeps a manual icon chosen before adding a custom platform', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram')])
    render(<Settings section="social" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'New platform name' }), { target: { value: 'My site' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose icon for My site' }))
    const picker = render(<>{mock.popovers[0].node}</>)
    fireEvent.click(picker.getByRole('button', { name: 'github.svg' }))
    picker.unmount()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(getSettings().socials[1]).toMatchObject({ label: 'My site', icon: 'github' })
  })

  it('deletes a platform on the second click of its remove button', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram'), link('wechat', 'WeChat')])
    render(<Settings section="social" />)

    const remove = screen.getByRole('button', { name: 'Remove WeChat' })
    fireEvent.click(remove)
    expect((mock.api.settings.get().socials as SocialLink[])).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete WeChat' }))
    expect((mock.api.settings.get().socials as SocialLink[]).map((entry) => entry.id)).toEqual(['instagram'])
  })
})

describe('contact social rows', () => {
  it('edits notes in the shared note field', async () => {
    await setupWithIcons()
    const { container } = render(<ContactForm contact={null} />)
    const notes = container.querySelector('textarea.ct-notes-editor') as HTMLTextAreaElement
    expect(notes).toBeTruthy()
    expect(notes.placeholder).toBe('Notes in Markdown')
    fireEvent.change(notes, { target: { value: '**Met** at the survey' } })
    expect(notes.value).toBe('**Met** at the survey')
  })

  it('picks a platform by its icon and stores the platform, not a typed name', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram'), link('wechat', 'WeChat'), link('vk', 'VK')])
    render(<ContactForm contact={null} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add social' }))
    // The row leads with the platform's mark, not a name field — an unset row
    // shows the picker's empty state.
    const picker = screen.getByRole('button', { name: 'Platform' })
    fireEvent.click(picker)

    expect(mock.popovers).toHaveLength(1)
    const grid = render(<>{mock.popovers[0].node}</>)
    fireEvent.click(grid.getByRole('button', { name: 'WeChat' }))
    grid.unmount()

    expect(screen.getByRole('button', { name: 'Platform: WeChat' })).toBeTruthy()
  })

  it('offers an unknown platform typed into the picker search', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram')])
    render(<ContactForm contact={null} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add social' }))
    fireEvent.click(screen.getByRole('button', { name: 'Platform' }))
    const grid = render(<>{mock.popovers[0].node}</>)

    fireEvent.change(grid.getByRole('textbox', { name: 'Search platforms' }), { target: { value: 'Chingari' } })
    fireEvent.click(grid.getByRole('button', { name: 'Use “Chingari”' }))
    grid.unmount()

    expect(screen.getByRole('button', { name: 'Platform: Chingari' })).toBeTruthy()
  })

  it('reorders a contact’s social rows from the keyboard', async () => {
    await setupWithIcons([link('instagram', 'Instagram'), link('vk', 'VK')])
    render(<ContactForm contact={null} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add social' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add social' }))
    fireEvent.change(screen.getAllByPlaceholderText('username')[0], { target: { value: 'otter' } })

    const grips = screen.getAllByTitle('Drag to reorder')
    expect(grips).toHaveLength(2)
    fireEvent.keyDown(grips[0], { key: 'ArrowDown' })

    // The row moved, not just its handle — the typed username travelled with it.
    expect(screen.getAllByPlaceholderText('username')[1]).toHaveValue('otter')
  })
})

describe('durable contact icons', () => {
  it('seeds missing defaults into the asset folder, keeps saved overrides and discovers new files', async () => {
    const custom = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>'
    const files = new Map<string, string>([['instagram.svg', custom], ['my-platform.svg', custom]])
    const opened: unknown[] = []
    const storage = {
      open: vi.fn(async (request: unknown) => { opened.push(request); return { handle: 'h' } }),
      close: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      list: vi.fn(async () => [...files].map(([name, text]) => ({ name, kind: 'file', size: text.length }))),
      write: vi.fn(async (location: { path: string }, text: string) => { files.set(location.path, text) }),
      read: vi.fn(async (location: { path: string }) => files.get(location.path) ?? '')
    }
    const result = await readContactIcons({ storage } as never)
    expect(opened[0]).toMatchObject({ area: 'metadata', path: 'assets/icons/contacts-icon' })
    expect(files.get('instagram.svg')).toBe(custom)
    expect(files.get('github.svg')).toContain('<svg')
    expect(result.icons.instagram).toBe(custom)
    expect(result.icons['my-platform']).toBe(custom)
    await readContactIcons({ storage } as never)
    expect(files.get('instagram.svg')).toBe(custom)
  })

  it('draws the folder icons, a saved override included', async () => {
    const custom = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>'
    const mock = setup()
    mock.api.backend.call = vi.fn(async () => ({ icons: { ...CONTACT_ICON_SVGS, instagram: custom, 'my-platform': custom } })) as never
    await act(async () => refreshContactIcons(mock.api))
    expect(hasContactIcon('My Platform')).toBe(true)
    const { container } = render(React.createElement(contactIcon('Instagram')))
    expect(container.querySelector('circle')).toBeTruthy()
  })

  it('removes active content and external resources from custom SVGs', () => {
    setup()
    const clean = sanitizeContactSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>html</div></foreignObject><image href="https://example.test/a"/><path d="M0 0h2" fill="url(https://example.test/a)" style="color:red"/></svg>')
    expect(clean).not.toMatch(/onload|script|foreignObject|image|https:|style=/)
    expect(clean).toContain('d="M0 0h2"')
    expect(() => sanitizeContactSvg('<not-svg/>')).toThrow()
  })
})
