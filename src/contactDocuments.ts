import { uiText } from './localization'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { GuardedTextDocumentResult, GuardedTextDocumentTrashResult, TextDocumentRead } from '@valley/plugin-sdk/types'
import type { Contact } from './types'
import { buildContactFile, CONTACT_EXTENSION, parseContactFile, updateContactFile } from './schema'

export const UNTITLED_FILE_BASE = 'Untitled'
export interface ContactDocumentOwner {
  root(): string
  assertCurrent(): void
  vault: Pick<ValleyPluginApi['vault'], 'stat' | 'readTextDocument' | 'writeTextDocumentGuarded' | 'createTextDocumentGuarded' | 'renameTextDocumentGuarded' | 'trashTextDocumentGuarded'>
  saveEditor?(path: string, content: string, before: TextDocumentRead): Promise<GuardedTextDocumentResult>
  validateBeforeEffect?(paths: string[]): Promise<void>
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim()
}

/** The file name (no extension) a contact's note is named after. */
export function contactFileBase(contact: Contact): string {
  return sanitizeFileName(
    [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.nickname || ''
  )
}

function parentFolder(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash > 0 ? relPath.slice(0, slash) : ''
}

function fileBase(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).replace(/\.vcf$/i, '')
}

/**
 * Whether nothing occupies `relPath`. Asks disk, never the vault index — the
 * index lags our own writes by a watcher round-trip, and a stale "occupied" hit
 * would number a contact away from a name it just vacated (e.g. on ⌘Z).
 */
async function pathIsFree(owner: ContactDocumentOwner, relPath: string, ignore?: string): Promise<boolean> {
  if (ignore && relPath.toLowerCase() === ignore.toLowerCase()) return true
  return (await owner.vault.stat(relPath)) === null
}

/**
 * The first free `<dir>/<base>.vcf`, auto-numbering `base 2`, `base 3`, … exactly
 * like the file tree's "Keep both". `ignore` is the contact's own path, so
 * re-saving (or a case-only rename) never numbers a contact away from itself.
 */
export async function uniqueContactPath(
  base: string,
  opts: { dir?: string; ignore?: string } = {},
  owner: ContactDocumentOwner
): Promise<string> {
  const dir = opts.dir ?? owner.root()
  const safe = sanitizeFileName(base) || UNTITLED_FILE_BASE
  const prefix = dir ? `${dir}/` : ''
  for (let n = 1; n < 1000; n++) {
    const relPath = `${prefix}${n === 1 ? safe : `${safe} ${n}`}${CONTACT_EXTENSION}`
    if (await pathIsFree(owner, relPath, opts.ignore)) return relPath
  }
  return `${prefix}${safe} ${Date.now()}${CONTACT_EXTENSION}`
}

/**
 * Rename a contact file to `targetBase` inside its own folder, resolving a free
 * name first. The rename is guarded by the receipt of the bytes just written, so
 * it never moves a file that changed since; wikilinks to it are repaired.
 * Returns the path and receipt afterwards — unchanged when the rename failed.
 */
export async function renameContactFile(relPath: string, targetBase: string, document: TextDocumentRead, owner: ContactDocumentOwner): Promise<{ relPath: string; document: TextDocumentRead | null }> {
  const base = sanitizeFileName(targetBase)
  if (!base || base === fileBase(relPath)) return { relPath, document }
  const newRelPath = await uniqueContactPath(base, { dir: parentFolder(relPath), ignore: relPath }, owner)
  if (newRelPath === relPath) return { relPath, document }
  // Any rename attempt spends the receipt; a fresh one is only valid while the
  // file still holds exactly the bytes this save wrote.
  const recapture = async (path: string): Promise<TextDocumentRead | null> => {
    const fresh = await owner.vault.readTextDocument(path).catch(() => null)
    return fresh && fresh.content === document.content ? fresh : null
  }
  await owner.validateBeforeEffect?.([relPath, newRelPath])
  const result = await owner.vault.renameTextDocumentGuarded(relPath, newRelPath, document.revisionToken)
  if (!result.ok) {
    console.warn(`[contacts] Could not rename ${relPath} → ${newRelPath}: ${result.reason}`)
    return { relPath, document: await recapture(relPath) }
  }
  if (result.editorConflict) return { relPath: result.relPath, document: null }
  return { relPath: result.relPath, document: result.revisionToken ? { content: document.content, revisionToken: result.revisionToken } : await recapture(result.relPath) }
}

export interface SaveContactOptions {
  /**
   * The contact as it was before this edit. Only fields that differ from it are
   * written, and it enables the auto-rename: the file name follows the person's
   * name, but only while it still matches it — a hand-named file is never
   * renamed behind the user's back.
   */
  previous?: Contact | null
  /** Explicit file name (no extension) from the form/CLI — always wins. */
  fileName?: string
  document?: TextDocumentRead
}

export interface ContactSave {
  relPath: string
  document: TextDocumentRead | null
  editorConflict: boolean
  restore(): Promise<void>
}

export async function readContactDocument(path: string, owner: ContactDocumentOwner): Promise<TextDocumentRead> {
  const index = owner
  index.assertCurrent()
  const document = await owner.vault.readTextDocument(path)
  index.assertCurrent()
  if (!document) throw new Error(uiText('contacts.error.load'))
  return document
}

/**
 * Persist a contact. An existing card keeps everything it does not describe; a
 * new card gets a free path so it can never overwrite a namesake. Returns the
 * committed path and its exact undo receipt, or null on failure.
 */
export async function saveContact(
  contact: Contact,
  opts: SaveContactOptions = {},
  owner: ContactDocumentOwner
): Promise<ContactSave | null> {
  const accepted = structuredClone(contact)
  const expected = opts.document ? { ...opts.document } : undefined
  const fileName = opts.fileName
  const index = owner
  index.assertCurrent()
  const relPath =
    accepted.relPath ||
    (await uniqueContactPath(sanitizeFileName(fileName ?? '') || contactFileBase(accepted), {}, owner))
  const before = accepted.relPath ? expected ?? await readContactDocument(relPath, owner) : null
  index.assertCurrent()
  const previous = structuredClone(opts.previous ?? (before ? parseContactFile(relPath, before.content) : null))
  const content = before
    ? updateContactFile(accepted, previous ?? accepted, before.content)
    : buildContactFile({ ...accepted, relPath })
  await owner.validateBeforeEffect?.([relPath])
  const written = before
    ? owner.saveEditor ? await owner.saveEditor(relPath, content, before) : content === before.content
      ? { ok: true as const, revisionToken: before.revisionToken, editorConflict: false }
      : await owner.vault.writeTextDocumentGuarded(relPath, content, before.revisionToken)
    : await owner.vault.createTextDocumentGuarded(relPath, content)
  if (!written.ok) return null
  let document: TextDocumentRead | null = 'revisionToken' in written && written.revisionToken ? { content, revisionToken: written.revisionToken } : null
  const editorConflict = 'editorConflict' in written && written.editorConflict
  const target = accepted.relPath && !editorConflict && document ? renameTargetFor(accepted, relPath, { previous, fileName }) : null
  let savedPath = relPath
  if (target && document) {
    let renamed: Awaited<ReturnType<typeof renameContactFile>>
    try { renamed = await renameContactFile(relPath, target, document, owner) }
    catch (cause) { if (owner.validateBeforeEffect && cause && typeof cause === 'object') Object.assign(cause, { outcome: 'unknown', outcomeUnknown: true, retryable: false }); throw cause }
    savedPath = renamed.relPath
    document = renamed.document
  }
  let restorePath = savedPath
  let restored = false
  return { relPath: savedPath, document, editorConflict, restore: async () => {
    index.assertCurrent()
    if (!document || restored) throw new Error(uiText('contacts.error.changed'))
    let receipt = document
    document = null
    if (!before) {
      const removed = await owner.vault.trashTextDocumentGuarded(restorePath, receipt.revisionToken)
      if (!removed.ok) throw new Error(uiText('contacts.error.deleteChanged'))
      restored = true
      const warning = contactTrashWarning(removed)
      if (warning) throw new Error(warning, { cause: removed })
      return
    }
    if (restorePath !== relPath) {
      const back = await renameContactFile(restorePath, fileBase(relPath), receipt, owner)
      if (back.relPath !== relPath || !back.document) throw new Error(uiText('contacts.error.changed'))
      restorePath = back.relPath
      receipt = back.document
    }
    if (receipt.content === before.content) { restored = true; return }
    const result = await owner.vault.writeTextDocumentGuarded(restorePath, before.content, receipt.revisionToken)
    if (!result.ok) throw new Error(uiText('contacts.error.changed'))
    restored = true
    if (result.editorConflict) throw new Error(uiText('contacts.error.changed'))
  } }
}

/** The file name a save should rename to, or null to leave the file alone. */
function renameTargetFor(contact: Contact, relPath: string, opts: SaveContactOptions): string | null {
  const current = fileBase(relPath)
  const explicit = sanitizeFileName(opts.fileName ?? '')
  if (explicit) return explicit === current ? null : explicit
  if (!opts.previous) return null
  const before = contactFileBase(opts.previous)
  const after = contactFileBase(contact)
  if (!after || after === before) return null
  // Only follow the name while the file still carries it (custom names stay).
  return current === before ? after : null
}

/** Soft-delete a contact file (undoable, into the vault trash). */
export async function deleteContact(relPath: string, owner: ContactDocumentOwner, document?: TextDocumentRead): Promise<Extract<GuardedTextDocumentTrashResult, { ok: true }>> {
  const before = document ?? await readContactDocument(relPath, owner)
  parseContactFile(relPath, before.content)
  owner.assertCurrent()
  const result = await owner.vault.trashTextDocumentGuarded(relPath, before.revisionToken)
  if (!result.ok) throw new Error(uiText('contacts.error.deleteChanged'))
  return result
}

export function contactTrashWarning(result: { editorConflict: boolean; recoverySaved: boolean }): string {
  return result.editorConflict || !result.recoverySaved
    ? uiText(result.recoverySaved ? 'contacts.error.deletedWithDraft' : 'contacts.error.deletedRecoveryFailed')
    : ''
}
