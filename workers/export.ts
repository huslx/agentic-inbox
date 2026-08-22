interface ExportEnv {
	BUCKET: R2Bucket;
	MAILBOX: DurableObjectNamespace;
	MIGRATION_SECRET: string;
}

function authorized(request: Request, env: ExportEnv) {
	return env.MIGRATION_SECRET.length >= 32
		&& request.headers.get("Authorization") === `Bearer ${env.MIGRATION_SECRET}`;
}

async function listMailboxes(bucket: R2Bucket) {
	const result: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: "mailboxes/", cursor });
		result.push(...page.objects.map((object) => object.key.slice("mailboxes/".length, -".json".length)));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return result;
}

export default {
	async fetch(request: Request, env: ExportEnv) {
		if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === "/mailboxes") return Response.json(await listMailboxes(env.BUCKET));

		if (url.pathname.startsWith("/mailbox/")) {
			const mailboxId = decodeURIComponent(url.pathname.slice("/mailbox/".length)).toLowerCase();
			const settingsObject = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
			if (!settingsObject) return new Response("Not found", { status: 404 });
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as any;
			const emails: unknown[] = [];
			for (let page = 1; ; page++) {
				const batch = await stub.getEmails({ page, limit: 100 });
				for (const email of batch) emails.push(await stub.getEmail(email.id));
				if (batch.length < 100) break;
			}
			return Response.json({
				id: mailboxId,
				settings: await settingsObject.json(),
				folders: await stub.getFolders(),
				emails,
			});
		}

		if (url.pathname === "/attachment") {
			const key = url.searchParams.get("key");
			if (!key?.startsWith("attachments/")) return new Response("Invalid key", { status: 400 });
			const object = await env.BUCKET.get(key);
			return object ? new Response(object.body) : new Response("Not found", { status: 404 });
		}

		return new Response("Not found", { status: 404 });
	},
};

