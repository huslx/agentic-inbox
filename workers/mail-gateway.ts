import type { SendEmailParams } from "./email-sender";
import { sendEmail } from "./email-sender";

interface GatewayEnv {
	BUCKET: R2Bucket;
	EMAIL: SendEmail;
	MAIL_GATEWAY_SECRET: string;
}

const encoder = new TextEncoder();

async function sign(secret: string, timestamp: string, body: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
	return `v1=${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function authorized(request: Request, env: GatewayEnv, body: string) {
	const timestamp = request.headers.get("X-Inbox-Timestamp");
	const supplied = request.headers.get("X-Inbox-Signature");
	if (!timestamp || !supplied || !env.MAIL_GATEWAY_SECRET || env.MAIL_GATEWAY_SECRET.length < 32) return false;
	if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
	const expected = await sign(env.MAIL_GATEWAY_SECRET, timestamp, body);
	if (expected.length !== supplied.length) return false;
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
	return mismatch === 0;
}

async function fetch(request: Request, env: GatewayEnv) {
	const url = new URL(request.url);

	if (request.method === "POST" && url.pathname === "/send") {
		const body = await request.text();
		if (!(await authorized(request, env, body))) return new Response("Unauthorized", { status: 401 });
		const result = await sendEmail(env.EMAIL, JSON.parse(body) as SendEmailParams);
		return Response.json(result);
	}

	if (request.method === "GET" && url.pathname === "/inbound/next") {
		if (!(await authorized(request, env, ""))) return new Response("Unauthorized", { status: 401 });
		const queued = await env.BUCKET.list({ prefix: "inbound-queue/", limit: 1 });
		if (!queued.objects.length) return new Response(null, { status: 204 });
		const object = await env.BUCKET.get(queued.objects[0].key);
		if (!object) return new Response(null, { status: 204 });
		return new Response(object.body, {
			headers: {
				"Content-Type": "message/rfc822",
				"X-Inbox-Key": object.key,
				"X-Inbox-From": object.customMetadata?.from ?? "",
				"X-Inbox-To": object.customMetadata?.to ?? "",
			},
		});
	}

	if (request.method === "POST" && url.pathname === "/inbound/ack") {
		const body = await request.text();
		if (!(await authorized(request, env, body))) return new Response("Unauthorized", { status: 401 });
		const { key } = JSON.parse(body) as { key?: string };
		if (!key?.startsWith("inbound-queue/")) return new Response("Invalid key", { status: 400 });
		await env.BUCKET.delete(key);
		return new Response(null, { status: 204 });
	}

	return new Response("Not found", { status: 404 });
}

export default {
	fetch,
	async email(event: ForwardableEmailMessage, env: GatewayEnv) {
		const key = `inbound-queue/${Date.now()}-${crypto.randomUUID()}.eml`;
		await env.BUCKET.put(key, event.raw, {
			customMetadata: { from: event.from, to: event.to },
		});
	},
};

