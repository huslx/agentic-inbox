import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export const requireAccess = createMiddleware(async (c, next) => {
	if (c.req.header("X-Internal-Tailscale") === "1") return next();

	const audience = process.env.POLICY_AUD;
	const teamDomain = process.env.TEAM_DOMAIN;
	if (!audience || !teamDomain) return c.text("Access authentication is not configured", 500);
	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) return c.text("Missing required CF Access JWT", 403);

	try {
		const teamUrl = new URL(teamDomain);
		const issuer = teamUrl.origin;
		jwks ??= createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
		await jwtVerify(token, jwks, { issuer, audience });
		await next();
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}
});

