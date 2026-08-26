import type { ConversationLogEntry } from "../types.js";

/**
 * Reads only — this app must never write or cache a copy of production logs.
 * Every call must be made with the requesting user's on-behalf-of token
 * (see auth/entra.ts) so reads are attributed to the human in the log
 * store's own audit trail, not a service account.
 *
 * Which log store (Elasticsearch / Azure Log Analytics / Splunk / a
 * warehouse table) is still unknown — see docs/open-questions.md. Swap this
 * stub for a real implementation once that's confirmed; the interface below
 * is the contract the routes depend on.
 */
export interface LogStoreClient {
  queryConversations(params: {
    onBehalfOfToken: string;
    region?: string;
    topic?: string;
    outcome?: "answered" | "escalated" | "abstained";
    thumbsDownOnly?: boolean;
    from?: string;
    to?: string;
  }): Promise<ConversationLogEntry[]>;

  getConversation(
    onBehalfOfToken: string,
    conversationId: string
  ): Promise<ConversationLogEntry | null>;
}

export class StubLogStoreClient implements LogStoreClient {
  async queryConversations(): Promise<ConversationLogEntry[]> {
    throw new Error("StubLogStoreClient: log store not configured yet.");
  }

  async getConversation(): Promise<ConversationLogEntry | null> {
    throw new Error("StubLogStoreClient: log store not configured yet.");
  }
}
