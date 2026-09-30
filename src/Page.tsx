import type { ReactElement } from 'react'
import type { MainWorkspaceViewProps, UiMenuItem } from '@valley/plugin-sdk'
import { absoluteVaultPath, buildAppOpenUrl } from '@valley/plugin-sdk/paths'
import { React, api } from './runtime'
import { useContacts, getStore } from './store'
import { ContactContent, setContactMode } from './contactView'
import { ContactForm, type ContactFormHandle } from './ContactForm'
import { RelationGraph } from './RelationGraph'
import { Copy, Download, ExternalLink, FolderOpen, Pencil, Trash } from './icons'
import { uiText } from './localization'
import { setContactSurfaceActions } from './surfaces'

/** Main-workspace page: a top bar (name + actions) over the detail / form / graph views. */
export function Page({ navigation }: MainWorkspaceViewProps): ReactElement {
  const snap = useContacts(api)
  const store = getStore(api)
  const selected = snap.contacts.find((c) => c.relPath === snap.selectedPath) ?? null
  const [busy, setBusy] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState('')
  const [downloading, setDownloading] = React.useState(false)
  const formRef = React.useRef<ContactFormHandle | null>(null)
  const pageRef = React.useRef<HTMLDivElement>(null)
  const [formAction, setFormAction] = React.useState({ saving: false, canSave: false, label: uiText('auto.efc007a393f6') })
  const onActionState = React.useCallback(
    (s: { saving: boolean; canSave: boolean; label: string }) => setFormAction(s),
    []
  )

  React.useEffect(() => {
    navigation.setController({
      canGoBack: snap.canGoBack,
      canGoForward: snap.canGoForward,
      goBack: store.goBack,
      goForward: store.goForward
    })
    return () => navigation.setController(null)
  }, [navigation, snap.canGoBack, snap.canGoForward, store])

  const isForm = snap.mode === 'create'
  const title =
    snap.mode === 'create'
      ? uiText('auto.f4101c50fadc')
      : snap.mode === 'edit'
        ? uiText('auto.857c28aa6caa')
        : snap.mode === 'graph'
          ? uiText('auto.6519fe11ef74')
          : (selected?.displayName ?? uiText('auto.b0dd615cbbdc'))

  const removeContact = async (): Promise<void> => {
    if (!selected || busy) return
    const owner = api
    const choice = await owner.ui.confirm({
      title: uiText('auto.1a9c123e5bcc', { p0: selected.displayName }),
      message: selected.relPath,
      actions: [
        { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
        { label: uiText('auto.572a73d31855'), value: 'delete', variant: 'danger' }
      ]
    })
    if (choice !== 'delete') return
    setBusy(true)
    setDeleteError('')
    try {
      const removed = await owner.commands.executeOwn('delete', { name: selected.relPath })
      if (!removed.ok) throw new Error(removed.error.message)
      const warning = (removed.value as { warning?: string }).warning
      setDeleteError(warning ?? '')
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : uiText('contacts.error.deleteChanged'))
    } finally {
      setBusy(false)
    }
  }

  const downloadVcf = async (): Promise<void> => {
    if (!selected || downloading) return
    setDownloading(true)
    try {
      // The stored card is already the portable vCard.
      await api.files.downloadFile(`${selected.fileName}.vcf`, await api.vault.readFile(selected.relPath))
    } finally {
      setDownloading(false)
    }
  }

  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text)
  }

  // Record actions first, then the card file's own actions, then the
  // destructive one behind a confirmation.
  const relPath = selected?.relPath ?? ''
  const actions: UiMenuItem[] = selected ? [
        { id: 'edit', label: uiText('auto.5301648dcf6b'), icon: <Pencil />, onSelect: () => { if (selected) setContactMode(selected.relPath, 'editing') } },
        { id: 'download', label: uiText('auto.763db9eef0e3'), icon: <Download />, onSelect: () => void downloadVcf() },
        { type: 'separator' },
        { id: 'reveal', label: api.files.revealLabel(), icon: <FolderOpen />, onSelect: () => api.files.revealInFinder(relPath) },
        { id: 'open-external', label: uiText('auto.713657474390'), icon: <ExternalLink />, onSelect: () => api.files.openWithDefaultApp(relPath) },
        { id: 'copy-relative', label: uiText('auto.75586047078a'), icon: <Copy />, onSelect: () => copyText(relPath) },
        { id: 'copy-absolute', label: uiText('auto.b96d429c4495'), icon: <Copy />, onSelect: () => copyText(absoluteVaultPath(api.getState().vault?.path, relPath)) },
        { id: 'copy-link', label: uiText('auto.fb3a16f382f8'), icon: <Copy />, onSelect: () => copyText(buildAppOpenUrl(relPath)) },
        { type: 'separator' },
        { id: 'trash', label: uiText('auto.572a73d31855'), icon: <Trash />, danger: true, onSelect: () => void removeContact() }
      ] : []
  React.useEffect(() => { setContactSurfaceActions(actions) })
  React.useEffect(() => () => setContactSurfaceActions(null), [])

  let body: ReactElement
  if (snap.mode === 'graph') {
    body = (
      <RelationGraph
        contacts={snap.contacts}
        groupConfigs={snap.groupConfigs}
        coverPaths={snap.coverPaths}
        focusPath={snap.selectedPath}
        onOpen={(p) => store.openContact(p)}
      />
    )
  } else if (snap.mode === 'create') {
    body = <ContactForm controlRef={formRef} contact={null} onActionState={onActionState} />
  } else if (snap.mode === 'edit' && selected) {
    body = <ContactContent key={selected.relPath} contact={selected} />
  } else if (selected) {
    body = <ContactContent key={selected.relPath} contact={selected} />
  } else {
    body = (
      <div className="ct-empty" style={{ padding: '40px 26px', maxWidth: 680, margin: '0 auto' }}>
        {uiText('auto.0db3c7060a5e')}</div>
    )
  }

  return (
    <div className="ct-page" ref={pageRef}>
      <div className="ct-page-head">
        <h2 className="ct-page-title">{title}</h2>
        <div className="ct-page-actions">
          {isForm && (
            <>
              <button className="ct-btn" onClick={() => formRef.current?.cancel()}>{uiText('auto.77dfd2135f4d')}</button>
              <button
                className="ct-btn primary"
                disabled={formAction.saving || !formAction.canSave}
                onClick={() => formRef.current?.save()}
              >
                {formAction.saving ? uiText('auto.56a2285c5b11') : formAction.label}
              </button>
            </>
          )}
        </div>
      </div>
      {deleteError && <p role="alert">{deleteError}</p>}
      <div className="ct-page-body">{body}</div>
    </div>
  )
}
