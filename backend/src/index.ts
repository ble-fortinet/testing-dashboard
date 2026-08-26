import express from "express";
import { testsRouter } from "./routes/tests.js";
import { logsRouter } from "./routes/logs.js";
import { promoteRouter } from "./routes/promote.js";
import { requireGroupMembership } from "./auth/entra.js";

const app = express();
app.use(express.json());

const DASHBOARD_ENTRA_GROUP_ID = process.env.DASHBOARD_ENTRA_GROUP_ID ?? "";
app.use(requireGroupMembership(DASHBOARD_ENTRA_GROUP_ID));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/tests", testsRouter);
app.use("/api/logs", logsRouter);
app.use("/api/promote", promoteRouter);

const port = process.env.PORT ?? 3001;
app.listen(port, () => {
  console.log(`dashboard backend listening on :${port}`);
});
