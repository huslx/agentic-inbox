import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { api } from "./api";
import { requireAccess } from "./auth";
import { initializeDatabase } from "./db";
import { processInboundEmail, startInboundPoller, verifySmtpSecret } from "./inbound";
import { handleMcp } from "./mcp";

await initializeDatabase();

const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok" }));
app.post("/internal/smtp", async (c) => {
	if (!verifySmtpSecret(c.req.header("X-SMTP-Secret"))) return c.text("Forbidden", 403);
	const from = c.req.header("X-Envelope-From") ?? "";
	const to = c.req.header("X-Envelope-To") ?? "";
	await processInboundEmail(await c.req.arrayBuffer(), from, to);
	return c.text("Accepted", 202);
});
app.use("*", requireAccess);
app.all("/mcp", (c) => handleMcp(c.req.raw));
app.route("/", api);
app.use("*", serveStatic({ root: "./build/client" }));

const serverBuild = await import(pathToFileURL(path.resolve("build/server/index.js")).href);
const render = createRequestHandler(serverBuild, process.env.NODE_ENV ?? "production");
app.all("*", (c) => render(c.req.raw, {} as any));
app.onError((error, c) => {
	console.error(error);
	return c.json({ error: "Internal server error" }, 500);
});

const port = Number(process.env.PORT ?? 18097);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
	console.log(`Agentic Inbox listening on http://127.0.0.1:${info.port}`);
});
startInboundPoller();
