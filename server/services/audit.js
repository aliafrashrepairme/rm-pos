// A failed audit write is logged but does not undo what the person just did.
export async function writeAudit(database, { user, userName, action, description = '', entityType = '', entityId = '' }) {
  const { error } = await database.from('audit_logs').insert({
    user_id: user?.id ?? null,
    user_name: user?.name ?? userName ?? 'Unknown',
    action,
    description,
    entity_type: entityType,
    entity_id: entityId
  });
  if (error) console.error('Audit log write failed:', error);
}
