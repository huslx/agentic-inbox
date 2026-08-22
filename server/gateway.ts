import { createHmac, timingSafeEqual } from "node:crypto";
import type { SendEmailParams } from "../workers/email-sender";

const MAX_CLOCK_SKEW_SECONDS = 300;

function secret() {
	const value = process.env.MAIL_GATEWAY_SECRET;
	if (!value || value.length < 32) throw new Error("MAIL_GATEWAY_SECRET must be at least 32 characters");
	return value;
}

function signature(timestamp: string, body: string) {
	return createHmac("sha256", secret()).update(`${timestamp}.${body}`).digest("hex");
}

function signedHeaders(body: string) {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	return {
		"X-Inbox-Timestamp": timestamp,
		"X-Inbox-Signature": `v1=${signature(timestamp, body)}`,
	};
}

export function verifyGatewaySignature(timestamp: string | null, supplied: string | null, body: string) {
	if (!timestamp || !supplied || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
	const expected = Buffer.from(`v1=${signature(timestamp, body)}`);
	const actual = Buffer.from(supplied);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function sendEmail(params: SendEmailParams) {
	const url = process.env.MAIL_GATEWAY_URL;
	if (!url) throw new Error("MAIL_GATEWAY_URL is required for outbound email");
	const body = JSON.stringify(params);
	const response = await fetch(`${url.replace(/\/$/, "")}/send`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...signedHeaders(body) },
		body,
	});
	if (!response.ok) throw new Error(`Mail gateway returned ${response.status}: ${await response.text()}`);
	return response.json() as Promise<{ messageId: string }>;
}

export async function pullInboundEmail() {
	const url = process.env.MAIL_GATEWAY_URL;
	if (!url) return null;
	const response = await fetch(`${url.replace(/\/$/, "")}/inbound/next`, {
		headers: signedHeaders(""),
	});
	if (response.status === 204) return null;
	if (!response.ok) throw new Error(`Mail gateway pull returned ${response.status}`);
	return {
		key: response.headers.get("X-Inbox-Key")!,
		from: response.headers.get("X-Inbox-From")!,
		to: response.headers.get("X-Inbox-To")!,
		raw: await response.arrayBuffer(),
	};
}

export async function acknowledgeInboundEmail(key: string) {
	const url = process.env.MAIL_GATEWAY_URL!;
	const body = JSON.stringify({ key });
	const response = await fetch(`${url.replace(/\/$/, "")}/inbound/ack`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...signedHeaders(body) },
		body,
	});
	if (!response.ok) throw new Error(`Mail gateway ack returned ${response.status}`);
}

