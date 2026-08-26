import { Router } from "express";
import { StubLogStoreClient } from "../clients/logStoreClient.js";

const logStore = new StubLogStoreClient();

export const logsRouter = Router();

// GET /api/logs?region=&topic=&outcome=&thumbsDown=&from=&to=
// Build order stage 3. Requires the caller's OBO token, not a service account.
logsRouter.get("/", async (_req, res) => {
  try {
    const entries = await logStore.queryConversations({ onBehalfOfToken: "" });
    res.json(entries);
  } catch (err) {
    res.status(501).json({ error: (err as Error).message });
  }
});

// GET /api/logs/:conversationId
logsRouter.get("/:conversationId", async (req, res) => {
  try {
    const entry = await logStore.getConversation("", req.params.conversationId);
    res.json(entry);
  } catch (err) {
    res.status(501).json({ error: (err as Error).message });
  }
});
