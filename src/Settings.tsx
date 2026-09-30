import type { ReactElement } from 'react'
import { React, api } from './runtime'
import type { SocialLink } from './types'
import { getSettings } from './data'
import { iconForPlatform } from './social'
import { ContactIconPicker, ContactIconSettings, useContactIcons } from './contactIcons'
import { GripVertical, MdDelete, X } from './icons'
import { uiText } from './localization'

function socialId(label: string): string {
  return `social_${label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'social'}`
}

function ConfirmRemoveButton({ onDelete, label }: { onDelete: () => void; label: string }): ReactElement {
  const [confirm, setConfirm] = React.useState(false)
  const timer = React.useRef<number | null>(null)
  const clear = React.useCallback((): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    setConfirm(false)
  }, [])
  React.useEffect(() => clear, [clear])
  return (
    <api.ui.settings.IconButton
      className={`ct-group-remove${confirm ? ' confirm' : ''}`}
      variant={confirm ? 'danger' : 'ghost'}
      onClick={() => {
        if (confirm) {
          clear()
          onDelete()
          return
        }
        setConfirm(true)
        timer.current = window.setTimeout(() => setConfirm(false), 3500)
      }}
      onBlur={clear}
      ariaLabel={confirm ? uiText('auto.97372e5fad97', { p0: label }) : uiText('auto.b8c425a1937d', { p0: label })}
      title={confirm ? uiText('auto.0b0311367700') : uiText('auto.e963907dac5c')}
    >
      {confirm ? <MdDelete /> : <X />}
    </api.ui.settings.IconButton>
  )
}

export function Settings(): ReactElement {
  useContactIcons()
  const initial = getSettings()
  const { Button, TextField, VaultFolderField, useReorderDrag } = api.ui.settings
  const [contactsRoot, setContactsRoot] = React.useState(initial.contactsRoot)
  const [socials, setSocials] = React.useState<SocialLink[]>(initial.socials)
  const [newSocialLabel, setNewSocialLabel] = React.useState('')
  const [newSocialUrl, setNewSocialUrl] = React.useState('')
  const [newSocialIcon, setNewSocialIcon] = React.useState<string>()
  const [duplicate, setDuplicate] = React.useState(false)

  React.useEffect(() => {
    if (!Object.prototype.hasOwnProperty.call(api.settings.get(), 'socials')) {
      void api.settings.set('socials', getSettings().socials)
    }
  }, [])

  const commitSocials = (next: SocialLink[]): void => {
    setSocials(next)
    void api.settings.set('socials', next)
  }
  const updateSocial = (id: string, patch: Partial<SocialLink>): void => {
    commitSocials(socials.map((social) => social.id === id ? { ...social, ...patch } : social))
  }
  const addSocial = (): void => {
    const label = newSocialLabel.trim()
    if (!label) return
    if (socials.some((social) => social.label.toLowerCase() === label.toLowerCase())) {
      setDuplicate(true)
      return
    }
    commitSocials([...socials, { id: socialId(label), label, url: newSocialUrl.trim(), ...(newSocialIcon ? { icon: newSocialIcon } : {}) }])
    setNewSocialLabel('')
    setNewSocialUrl('')
    setNewSocialIcon(undefined)
    setDuplicate(false)
  }

  // The stored array order is the order the platforms are offered in — in the
  // contact editor's picker and in the detail view — so reordering here is the
  // one place it is set. Assert the keyboard path in tests: jsdom has no layout,
  // and the pointer path's midpoint maths reads zeroed rects.
  const reorder = useReorderDrag<SocialLink>({
    items: socials,
    getId: (social) => social.id,
    getLabel: (social) => social.label,
    onReorder: commitSocials
  })

  return (
    <section className="settings-section">
      <h4 className="settings-label">{uiText('auto.b0dd615cbbdc')}</h4>
      <api.ui.settings.Row title={uiText('auto.ecea12d8f363')} description={uiText('contacts.settings.rootDescription')}>
        <VaultFolderField
          value={contactsRoot}
          onChange={setContactsRoot}
          onCommit={(value) => void api.settings.set('contactsRoot', value)}
          ariaLabel={uiText('auto.ecea12d8f363')}
        />
      </api.ui.settings.Row>
      <api.ui.settings.Row
        title={uiText('auto.ae9629f4ebb8')}
        description={uiText('contacts.settings.groupsDesc')}
      >
        <Button onClick={() => api.workspace.openSettings('groups')}>
          {uiText('contacts.settings.groups')}
        </Button>
      </api.ui.settings.Row>

      <div className="settings-section-divider" />
      <ContactIconSettings />
      <div className="settings-colorrules ct-social-settings">
        <span className="settings-toggle-text">
          <span className="settings-toggle-title">{uiText('auto.52e0b0a389f8')}</span>
          <span className="settings-toggle-desc">
            {uiText('auto.658128ca827d')}{' '}<code>{'{}'}</code>{' '}{uiText('auto.928154ade660')}
          </span>
        </span>
        <div className="ct-social-setting-head" aria-hidden="true">
          <span />
          <span />
          <span>{uiText('auto.23cad2b6b992')}</span>
          <span>{uiText('auto.93a4103c024a')}</span>
          <span />
        </div>
        {socials.map((social) => {
          const Icon = iconForPlatform(social.label, social.icon)
          const handleProps = reorder.getHandleProps(social)
          return (
            <div
              className={`ct-social-setting-row${reorder.overId === social.id ? ` drop-${reorder.dropPosition ?? 'before'}` : ''}`}
              key={social.id}
              {...reorder.getItemProps(social)}
            >
              <button
                {...handleProps}
                className={`${handleProps.className ?? ''} ct-social-grip ct-social-settings-grip`}
                title={uiText('contacts.social.reorder')}
                onDragStart={(event) => {
                  handleProps.onDragStart?.(event)
                  if (event.defaultPrevented || !event.dataTransfer?.setDragImage) return
                  const handle = event.currentTarget
                  const bounds = handle.getBoundingClientRect()
                  const ghost = handle.cloneNode(true) as HTMLButtonElement
                  ghost.classList.add('ct-social-drag-ghost')
                  ghost.style.width = `${bounds.width}px`
                  ghost.style.height = `${bounds.height}px`
                  handle.ownerDocument.body.appendChild(ghost)
                  event.dataTransfer.setDragImage(ghost, bounds.width / 2, bounds.height / 2)
                  window.setTimeout(() => ghost.remove(), 0)
                }}
              ><GripVertical /></button>
              <ContactIconPicker name={social.label} icon={social.icon} onChange={(icon) => updateSocial(social.id, { icon })}><Icon /></ContactIconPicker>
              <label className="ct-social-setting-field">
                <TextField
                  value={social.label}
                  onChange={(label) => setSocials(socials.map((entry) => entry.id === social.id ? { ...entry, label } : entry))}
                  onCommit={(label) => updateSocial(social.id, { label: label.trim() || social.label })}
                  onEscape={() => setSocials(getSettings().socials)}
                  ariaLabel={uiText('auto.23cad2b6b992')}
                />
              </label>
              <label className="ct-social-setting-field ct-social-setting-url">
                <TextField
                  value={social.url}
                  onChange={(url) => setSocials(socials.map((entry) => entry.id === social.id ? { ...entry, url } : entry))}
                  onCommit={(url) => updateSocial(social.id, { url: url.trim() })}
                  onEscape={() => setSocials(getSettings().socials)}
                  placeholder="https://example.com/{}"
                  ariaLabel={uiText('auto.93a4103c024a')}
                  spellCheck={false}
                />
              </label>
              <ConfirmRemoveButton label={social.label} onDelete={() => commitSocials(socials.filter((entry) => entry.id !== social.id))} />
            </div>
          )
        })}
        <div className="ct-social-setting-row ct-social-setting-add">
          <span className="ct-social-grip ct-social-settings-grip" aria-hidden="true" />
          <ContactIconPicker name={newSocialLabel || uiText('auto.042b0b89db47')} icon={newSocialIcon} onChange={setNewSocialIcon}>
            {React.createElement(iconForPlatform(newSocialLabel, newSocialIcon))}
          </ContactIconPicker>
          <label className="ct-social-setting-field">
            <TextField
              value={newSocialLabel}
              onChange={(value) => { setNewSocialLabel(value); setDuplicate(false) }}
              onCommit={addSocial}
              invalid={duplicate}
              ariaLabel={uiText('auto.042b0b89db47')}
            />
          </label>
          <label className="ct-social-setting-field ct-social-setting-url">
            <TextField
              value={newSocialUrl}
              onChange={setNewSocialUrl}
              onCommit={addSocial}
              placeholder="https://example.com/{}"
              ariaLabel={uiText('auto.c0251fe352c8')}
              spellCheck={false}
            />
          </label>
          <Button onClick={addSocial}>{uiText('auto.61cc55aa0453')}</Button>
        </div>
        {duplicate && <span className="settings-empty-text">{uiText('contacts.settings.groupDuplicate')}</span>}
        {reorder.liveRegion}
      </div>
    </section>
  )
}
