import type { ReactElement } from 'react'
import { React, api } from './runtime'
import type { Contact } from './types'
import { useContacts } from './store'
import { parseContactFile } from './schema'
import { ContactContent } from './contactView'
import { uiText } from './localization'

/**
 * The contact a `.vcf` path holds: the live list's entry when the file is in the
 * contacts folder, else the card read straight from the file (and re-read when
 * it changes), so any `.vcf` in the vault can be viewed and edited.
 */
export function useContactFile(path: string): { contact: Contact | null; loaded: boolean } {
  const snap = useContacts(api)
  const listed = snap.contacts.find((entry) => entry.relPath === path) ?? null
  const [direct, setDirect] = React.useState<{ path: string; contact: Contact | null } | null>(null)
  React.useEffect(() => {
    if (listed) return
    let disposed = false
    const read = (): void => {
      void api.vault.readFile(path).then((raw) => {
        if (disposed) return
        try { setDirect({ path, contact: parseContactFile(path, raw) }) } catch { setDirect({ path, contact: null }) }
      })
    }
    read()
    const off = api.vault.onChanged((info) => { if (info.full || info.changes.some((change) => change.relPath === path)) read() })
    return () => { disposed = true; off() }
  }, [path, Boolean(listed)])
  if (listed) return { contact: listed, loaded: true }
  return direct?.path === path ? { contact: direct.contact, loaded: true } : { contact: null, loaded: false }
}

/** A `.vcf` file opened from the file tree or a link. */
export function ContactFileView({ relPath }: { relPath: string }): ReactElement | null {
  const { contact, loaded } = useContactFile(relPath)
  if (!loaded) return null
  if (!contact) return <div className="ct-empty" style={{ padding: '40px 26px' }}>{uiText('contacts.error.notVCard')}</div>
  return (
    <div className="ct-page ct-file-page">
      <div className="ct-page-body"><ContactContent key={relPath} contact={contact} /></div>
    </div>
  )
}
