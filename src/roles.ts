import type { PublicSessionMeta, RoleSelection } from '@waksana/cockpit-module-sdk/backend';
import type { Caller } from './gateway.ts';
import { fingerprint } from './store.ts';

const key = (role: RoleSelection) => `${role.moduleId}/${role.roleId}`;
export const sameRoles = (left: readonly RoleSelection[] | undefined, right: readonly RoleSelection[] | undefined) =>
  !!left && !!right && left.length === right.length
  && new Set(left.map(key)).size === left.length && new Set(right.map(key)).size === right.length
  && left.every(role => right.some(other => key(role) === key(other)));

// Identity is not compatibility: Host availability and native resources authorize use.
export function assistantRole(roles: readonly RoleSelection[] | undefined): Caller['role'] | null {
  if (!roles?.length || roles.length > 64 || !sameRoles(roles, roles)) return null;
  const identities = roles.filter(role => role.moduleId === 'assistant');
  if (identities.length !== 1) return null;
  const role = identities[0]!.roleId;
  return role === 'coordinator' || role === 'organizer' ? role : null;
}
export const appliedAssistantRole = (meta: PublicSessionMeta | null) =>
  meta?.loaded && meta.rolesNeedReload === false && sameRoles(meta.roles, meta.appliedRoles)
    ? assistantRole(meta.appliedRoles) : null;
export const roleIdentity = (meta: PublicSessionMeta) => fingerprint({
  roles: meta.roles, appliedRoles: meta.appliedRoles, rolesNeedReload: meta.rolesNeedReload,
});
