import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { disposeStore } from '../src/store'
import { Settings } from '../src/Settings'
import { ContactForm } from '../src/ContactForm'
import { canonicalPlatform, defaultSocialLinks, iconForPlatform, resolveSocial } from '../src/social'
import { contactIcon, refreshContactIcons, sanitizeContactSvg, hasContactIcon } from '../src/contactIcons'
import { getSettings } from '../src/data'
import { emptyContact } from '../src/schema'
import type { SocialLink } from '../src/types'
import { readContactIcons } from '../src/backend/icons'
import config from '../config.json'

declare const CONTACT_ICON_SVGS: Record<string, Record<string, string>>

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

async function renderSettings(section = 'social'): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<Settings section={section === 'main' ? undefined : section} />) })
  return view
}

/** The platform list, apart from the label lists below it on the same page. */
const socialList = (container: HTMLElement): HTMLElement => container.querySelector('.ct-social-settings:not(.ct-label-settings)') as HTMLElement

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
  it('lives on the Social media sub-page with the labels, beside Groups; the main page keeps the folder', async () => {
    await setupWithIcons([link('instagram', 'Instagram')])
    expect(config.settingsSections.map((section) => section.id)).toEqual(['social', 'groups'])
    expect(config.settingsSections[0].label).toBe('Social media')
    const main = await renderSettings('main')
    expect(screen.getByText('Contacts folder')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'New platform name' })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Phone' })).toBeNull()
    main.unmount()
    await act(async () => { render(<Settings section="social" />) })
    expect(screen.getByText('Social links')).toBeInTheDocument()
    expect(screen.getByText(/contact-icon\/social-media/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'New platform name' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Phone' })).toBeInTheDocument()
    cleanup()
    await act(async () => { render(<Settings section="groups" />) })
    expect(screen.queryByRole('textbox', { name: 'New platform name' })).toBeNull()
  })

  it('ends the add row in a + where the rows end in ×, on the same columns', async () => {
    await setupWithIcons([link('instagram', 'Instagram')])
    const view = await renderSettings('social')
    const add = view.container.querySelector('.ct-social-setting-add') as HTMLElement
    expect(add.querySelector('.ct-settings-add')).toHaveAccessibleName('Add platform')
    expect(within(add).queryByRole('button', { name: 'Add' })).toBeNull()
    expect(add.children).toHaveLength(view.container.querySelector('.ct-social-setting-row:not(.ct-social-setting-add)')!.children.length)
  })

  it('reorders the registry from the keyboard and writes the new order', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram'), link('wechat', 'WeChat'), link('vk', 'VK')])
    const view = await renderSettings()

    const grips = within(socialList(view.container)).getAllByTitle('Drag to reorder')
    expect(grips).toHaveLength(3)

    fireEvent.keyDown(grips[0], { key: 'ArrowDown' })

    expect((mock.api.settings.get().socials as SocialLink[]).map((entry) => entry.id))
      .toEqual(['wechat', 'instagram', 'vk'])
  })

  it('persists a manual SVG selection across remounts and can return to automatic matching', async () => {
    const mock = await setupWithIcons([link('custom', 'My platform')])
    const view = await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Choose icon for My platform' }))
    const picker = render(<>{mock.popovers[0].node}</>)
    fireEvent.change(picker.getByRole('textbox', { name: 'Search icons' }), { target: { value: 'github' } })
    fireEvent.click(picker.getByRole('button', { name: 'github.svg' }))
    picker.unmount()
    expect(getSettings().socials[0].icon).toBe('github')
    expect(resolveSocial({ platform: 'custom' }, getSettings().socials).icon).toBe(contactIcon('github'))
    view.unmount()
    await renderSettings()
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
    const view = await renderSettings()
    fireEvent.change(screen.getByRole('textbox', { name: 'New platform name' }), { target: { value: 'My site' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose icon for My site' }))
    const picker = render(<>{mock.popovers[0].node}</>)
    fireEvent.click(picker.getByRole('button', { name: 'github.svg' }))
    picker.unmount()
    fireEvent.click(within(socialList(view.container)).getByRole('button', { name: 'Add platform' }))
    expect(getSettings().socials[1]).toMatchObject({ label: 'My site', icon: 'github' })
  })

  it('deletes a platform on the second click of its remove button', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram'), link('wechat', 'WeChat')])
    await renderSettings()

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
    const notes = container.querySelector('.ct-notes-editor textarea') as HTMLTextAreaElement
    expect(notes).toBeTruthy()
    expect(notes.placeholder).toBe('Notes in Markdown')
    fireEvent.change(notes, { target: { value: '**Met** at the survey' } })
    expect(notes.value).toBe('**Met** at the survey')
  })

  it('picks the platform by name from the configured platforms, in their order', async () => {
    const mock = await setupWithIcons([link('instagram', 'Instagram'), link('wechat', 'WeChat'), link('vk', 'VK')])
    render(<ContactForm contact={null} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add social' }))
    const platform = screen.getByRole('combobox', { name: 'Platform' }) as HTMLSelectElement
    expect([...platform.options].map((option) => option.textContent)).toEqual(['Instagram', 'WeChat', 'VK', 'Edit platforms…'])
    fireEvent.change(platform, { target: { value: 'WeChat' } })
    expect(platform.value).toBe('WeChat')

    const open = vi.spyOn(mock.api.workspace, 'openSettings')
    fireEvent.change(platform, { target: { value: '__contacts-edit__' } })
    expect(open).toHaveBeenCalledWith('plugin:contacts#social')
    expect(platform.value).toBe('WeChat')
  })

  it('keeps a saved platform that is not configured in the list', async () => {
    await setupWithIcons([link('instagram', 'Instagram')])
    render(<ContactForm contact={{ ...emptyContact(''), socialMedia: [{ platform: 'Chingari', handle: 'otter' }] }} />)

    const platform = screen.getByRole('combobox', { name: 'Platform' }) as HTMLSelectElement
    expect(platform.value).toBe('Chingari')
    expect([...platform.options].map((option) => option.textContent)).toEqual(['Instagram', 'Chingari', 'Edit platforms…'])
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
  it('seeds each icon folder with its missing defaults, keeps saved overrides and discovers new files', async () => {
    const custom = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>'
    const files = new Map<string, string>([['social-media/instagram.svg', custom], ['social-media/my-platform.svg', custom], ['address/cabin.svg', custom]])
    const opened: unknown[] = []
    const storage = {
      open: vi.fn(async (request: unknown) => { opened.push(request); return { handle: 'h' } }),
      close: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      list: vi.fn(async (location: { path: string }) => [...files].filter(([path]) => path.startsWith(`${location.path}/`) && !path.slice(location.path.length + 1).includes('/'))
        .map(([path, text]) => ({ name: path.slice(location.path.length + 1), kind: 'file', size: text.length }))),
      write: vi.fn(async (location: { path: string }, text: string) => { files.set(location.path, text) }),
      read: vi.fn(async (location: { path: string }) => files.get(location.path) ?? '')
    }
    const result = await readContactIcons({ storage } as never)
    expect(opened[0]).toMatchObject({ area: 'metadata', path: 'assets/icons/contact-icon' })
    expect(Object.keys(result.icons).sort()).toEqual(['address', 'birthday', 'email', 'phone', 'social-media', 'website'])
    expect(files.get('social-media/instagram.svg')).toBe(custom)
    expect(files.get('social-media/github.svg')).toContain('<svg')
    expect(files.get('address/home.svg')).toContain('<svg')
    expect(files.get('birthday/cake.svg')).toContain('<svg')
    expect(result.icons['social-media'].instagram).toBe(custom)
    expect(result.icons['social-media']['my-platform']).toBe(custom)
    expect(result.icons.address.cabin).toBe(custom)
    await readContactIcons({ storage } as never)
    expect(files.get('social-media/instagram.svg')).toBe(custom)
  })

  it('bundles the icons into the backend: the build replaces the exact declaration the backend carries', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const declaration = /CONTACT_ICON_DECLARATION = '([^']+)'/.exec(readFileSync(join(process.cwd(), 'tooling/contactIcons.mjs'), 'utf8'))?.[1]
    expect(declaration).toBeTruthy()
    expect(readFileSync(join(process.cwd(), 'src/backend/icons.ts'), 'utf8')).toContain(declaration)
  })

  it('draws the folder icons, a saved override included, each from its own folder', async () => {
    const custom = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>'
    const mock = setup()
    mock.api.backend.call = vi.fn(async () => ({ icons: { ...CONTACT_ICON_SVGS, 'social-media': { ...CONTACT_ICON_SVGS['social-media'], instagram: custom, 'my-platform': custom } } })) as never
    await act(async () => refreshContactIcons(mock.api))
    expect(hasContactIcon('My Platform')).toBe(true)
    expect(hasContactIcon('home')).toBe(false)
    expect(hasContactIcon('home', 'address')).toBe(true)
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
