#!/usr/bin/env node
import http from "node:http";
import { createAssistantApp } from "./app.js";
import { createConfigStore } from "./config.js";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

const store = createConfigStore();
const token = await store.accessToken();
const app = createAssistantApp({ store, token });

http.createServer(app.handle).listen(port, host, () => {
	const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
	console.log("EditorA AI Assistant is running.");
	console.log(`Open: http://${shown}:${port}/#token=${token}`);
	console.log(`Settings and keys: ${store.file}`);
	if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
		console.warn(
			"Warning: listening beyond this device. Anyone with the token can push and merge; put it behind HTTPS before exposing it.",
		);
	}
});
