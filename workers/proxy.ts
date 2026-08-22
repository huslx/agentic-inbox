const ORIGIN = "https://0f6139ab-4516-4fa6-b925-24ef2344b4e1.cfargotunnel.com";

export default {
	async fetch(request: Request) {
		const incoming = new URL(request.url);
		const target = new URL(`${incoming.pathname}${incoming.search}`, ORIGIN);
		const headers = new Headers(request.headers);
		headers.set("X-Forwarded-Host", incoming.host);
		return fetch(new Request(target, {
			method: request.method,
			headers,
			body: request.body,
			redirect: "manual",
		}));
	},
};

