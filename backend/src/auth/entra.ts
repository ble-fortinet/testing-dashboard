/**
 * Entra SSO + on-behalf-of token exchange, stubbed.
 *
 * Real flow: validate the inbound user token from the SPA, check the caller
 * is a member of DASHBOARD_ENTRA_GROUP_ID, then exchange for an OBO token
 * scoped to the log store so downstream reads are attributed to the human,
 * not this service. Needs an app registration — not created yet.
 */
export interface AuthenticatedUser {
  oid: string;
  upn: string;
  groupIds: string[];
}

export function requireGroupMembership(_groupId: string) {
  return (_req: unknown, _res: unknown, next: () => void) => {
    // TODO: validate bearer token, check groupIds includes DASHBOARD_ENTRA_GROUP_ID
    next();
  };
}

export async function exchangeForLogStoreToken(
  _userToken: string
): Promise<string> {
  throw new Error(
    "exchangeForLogStoreToken: Entra app registration not configured yet."
  );
}
