import {
  createAgentToolProvider,
  type AgentToolExecutionContext,
  type AgentToolProvider,
  type ValleyPluginApi
} from '@valley/plugin-sdk'

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false
})
const text = (description: string) => ({ type: 'string', description })
const str = (value: unknown) => value == null ? '' : String(value)

async function execute<T>(api: ValleyPluginApi, id: string, input: unknown, context?: AgentToolExecutionContext): Promise<T> {
  const result = await api.commands.executeOwn(id, input, { ...context, autonomous: true })
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

export function contactsAgentTools(api: ValleyPluginApi): AgentToolProvider {
  const contactFields = {
    name: text('Existing contact name'),
    firstName: text('New first name'), middleName: text('New middle name'), lastName: text('New last name'),
    nickname: text('New nickname'), birthdate: text('Birthdate YYYY-MM-DD'), profession: text('Profession'),
    cover: text('Cover path'), lastContact: text('Last-contact date YYYY-MM-DD'),
    groups: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
  }
  return createAgentToolProvider([
    {
      name: 'open_contact', description: 'Open a Contacts entry by name.',
      parameters: schema({ name: text('Contact name') }, ['name']), sideEffect: 'read', commandId: 'open',
      run: async (args, context) => {
        const contact = await execute<{ displayName?: string }>(api, 'open', { name: str(args.name) }, context)
        return `Opened contact ${contact.displayName || str(args.name)}.`
      }
    },
    {
      name: 'edit_contact', description: 'Edit the structured fields of a Contacts entry.',
      parameters: schema(contactFields, ['name']), sideEffect: 'write', commandId: 'update',
      run: async (args, context) => {
        const input: Record<string, unknown> = { name: str(args.name) }
        for (const key of Object.keys(contactFields).filter((key) => key !== 'name')) {
          const value = args[key]
          if (value === undefined) continue
          input[key] = key === 'groups' && Array.isArray(value) ? value.map(str).join(',') : value
        }
        const contact = await execute<{ displayName?: string }>(api, 'update', input, context)
        return `Updated contact ${contact.displayName || str(args.name)}.`
      }
    },
    {
      name: 'delete_contact', description: 'Soft-delete a Contacts entry by name.',
      parameters: schema({ name: text('Contact name') }, ['name']), sideEffect: 'write', commandId: 'delete',
      run: async (args, context) => {
        const contact = await execute<{ displayName?: string }>(api, 'delete', { name: str(args.name) }, context)
        return `Deleted contact ${contact.displayName || str(args.name)}.`
      }
    },
    {
      name: 'get_contact', description: "Get a contact's structured information by name.",
      parameters: schema({ name: text('Contact name') }, ['name']), sideEffect: 'read', commandId: 'get',
      run: async (args, context) => JSON.stringify(
        await execute(api, 'get', { name: str(args.name) }, context), null, 2
      )
    },
    {
      name: 'read_contact_note', description: "Read a contact's freeform note body by name.",
      parameters: schema({ name: text('Contact name'), maxChars: { type: 'number' } }, ['name']),
      sideEffect: 'read', commandId: 'note',
      run: async (args, context) => {
        const result = await execute<{ displayName?: string; note?: string; truncated?: boolean; totalChars?: number }>(
          api, 'note', { name: str(args.name), maxChars: args.maxChars }, context
        )
        if (!result.note) return `${result.displayName || str(args.name)} has no note.`
        return result.truncated ? `${result.note}\n…(truncated, ${result.totalChars ?? 0} chars total)` : result.note
      }
    },
    {
      name: 'list_contacts', description: 'List or search Contacts entries.',
      parameters: schema({ query: text('Optional search text'), group: text('Optional group') }),
      sideEffect: 'read', commandId: 'list',
      run: async (args, context) => {
        const contacts = await execute<Array<{ displayName?: string; groups?: string[] }>>(
          api, 'list', { query: str(args.query), group: str(args.group) }, context
        )
        return contacts.length
          ? contacts.slice(0, 60).map((contact) =>
              `- ${contact.displayName ?? ''}${contact.groups?.length ? ` [${contact.groups.join(', ')}]` : ''}`
            ).join('\n')
          : 'No contacts match.'
      }
    }
  ])
}
