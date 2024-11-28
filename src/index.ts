import { DurableObject } from 'cloudflare:workers';

// Worker
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.url.endsWith('/websocket')) {
			// Expect to receive a WebSocket Upgrade request.
			// If there is one, accept the request and return a WebSocket Response.
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Durable Object expected Upgrade: websocket', {
					status: 426,
				});
			}

			if (request.method !== 'GET') {
				return new Response('Durable Object expected GET method', {
					status: 400,
				});
			}

			// This example will refer to the same Durable Object,
			// since the name "foo" is hardcoded.
			let id = env.WEBSOCKET_HIBERNATION_SERVER.idFromName('foo');
			let stub = env.WEBSOCKET_HIBERNATION_SERVER.get(id);

			return stub.fetch(request);
		}

		return new Response(null, {
			status: 400,
			statusText: 'Bad Request',
			headers: {
				'Content-Type': 'text/plain',
			},
		});
	},
};

// Durable Object
export class WebSocketHibernationServer extends DurableObject {
	// Keep track of all WebSocket connections
	sessions: Map<WebSocket, any>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sessions = new Map();

		// DO saves the connection information when it goes to hibernation
		// Get all WebSocket connections from the DO
		this.ctx.getWebSockets().forEach((ws) => {
			// Checks if this is a new DO
			if (ws.deserializeAttachment()) {
				// If a DO is waking up, deserialize the attachment.
				// This helps to restore the state of the connection
				const { ...session } = ws.deserializeAttachment();
				this.sessions.set(ws, { ...session });
			}
		});

		// Sets an application level auto response that does not wake hibernated WebSockets.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	async fetch(request: Request): Promise<Response> {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `acceptWebSocket()` informs the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		// Unlike `ws.accept()`, `state.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket
		// is "hibernatable", so the runtime does not need to pin this Durable Object to memory while
		// the connection is open. During periods of inactivity, the Durable Object can be evicted
		// from memory, but the WebSocket connection will remain open. If at some later point the
		// WebSocket receives a message, the runtime will recreate the Durable Object
		// (run the `constructor`) and deliver the message to the appropriate handler.
		this.ctx.acceptWebSocket(server);

		// Generate a random UUID for the session.
		const id = crypto.randomUUID();

		// Attach the session ID to the WebSocket connection and serialize it.
		// This is necessary to restore the state of the connection when the Durable Object wakes up.
		server.serializeAttachment({
			...server.deserializeAttachment(),
			id,
		});

		// Add the WebSocket connection to the map of active sessions.
		this.sessions.set(server, { id });

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(sender: WebSocket, message: ArrayBuffer | string) {
		// Get the session associated with the WebSocket connection.
		const session = this.sessions.get(sender);

		// Upon receiving a message from the client, the server replies with the same message, the session ID of the sender,
		// and the total number of connections with the "[Durable Object]: " prefix
		sender.send(`[Durable Object] message: ${message}, from: ${session.id}. Total connections: ${this.ctx.getWebSockets().length}`);

		// Send a message to all WebSocket connections, loop over all the connected WebSockets.
		// This wakes up all the connections and the DO is no longer in hibernation.
		this.ctx.getWebSockets().forEach((ws) => {
			ws.send(`[Durable Object] message: ${message}, from: ${session.id}. Total connections: ${this.ctx.getWebSockets().length}`);
		});

		// Send a message to all WebSocket connections except the sender, loop over all the connected WebSockets and filter out the sender.
		// This wakes up all the connections and the DO is no longer in hibernation.
		this.ctx.getWebSockets().forEach((ws) => {
			if (ws !== sender) {
				ws.send(`[Durable Object] message: ${message}, from: ${session.id}. Total connections: ${this.ctx.getWebSockets().length}`);
			}
		});
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// If the client closes the connection, the runtime will invoke the webSocketClose() handler.
		ws.close(code, 'Durable Object is closing WebSocket');
	}
}
