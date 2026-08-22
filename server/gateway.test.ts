import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyGatewaySignature } from "./gateway";

test("mail gateway signatures reject changed payloads", () => {
	process.env.MAIL_GATEWAY_SECRET = "a".repeat(32);
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const body = "payload";
	const signature = `v1=${createHmac("sha256", process.env.MAIL_GATEWAY_SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
	assert.equal(verifyGatewaySignature(timestamp, signature, body), true);
	assert.equal(verifyGatewaySignature(timestamp, signature, `${body}!`), false);
});

