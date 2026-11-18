/**
 * Capabilities are extra powers an owner hands to a specific person.
 * Owners implicitly hold all of them; nobody else holds any by default.
 */
export const CAPABILITIES = [
  'users.manage',
  'devices.approve',
  'audit.view',
  'export',
  'bulk_delete',
  'automations.manage',
  'secret_fields.reveal',
  'system.config',
  'reports.view',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function hasCapability(
  actor: { role: string; capabilities: readonly string[] },
  capability: Capability,
): boolean {
  return actor.role === 'owner' || actor.capabilities.includes(capability);
}
