const MongoDB = require("mongodb");

const fs = require("fs").promises;
const express = require("express");
const fclone = require('fclone');
const path = require("path");
const app = express();

const CONFIG_PATH = path.resolve(process.argv[2] ? process.argv[2] : "./http-mongodb.json");
const NPM_NAME = "HTTP -> MongoDB";

const DEFAULT_CONFIG = {
	connection: "mongodb://localhost:27017",
	web_port: "27020",
	client: {
		useNewUrlParser: true,
		useUnifiedTopology: true,
		connectTimeoutMS: 2000
	}
}

async function runtime(config) {
	if (!config) return;

	async function error(reason = "", context = {}, status = 400, response) {
		const object = {
			error: {
				reason, ...context, status
			}
		};

		if (response) {
			response.status(status);
			response.json(object);
		}

		return object;
	}

	async function parse(object) {
		if (object.constructor.name === "Cursor") {
			object = await object.toArray();
		}

		object = fclone(object);
		return object;
	}
	
	app.use(express.json());

	app.all("*", async(req, res, next) => {
		setTimeout(async() => {
			if (res.headersSent) return;
			return await error("timeout", null, 500, res);
		}, 10 * 1000); // 10 seconds.

		next();
	})

	app.post("/*", async(req, res, next) => {

		if (req.body && !Array.isArray(req.body)) {
			return await error("invalid_body", {
				message: "body must be json array"
			}, 400, res);
		}

		let auth = null;
		let authorization = req.get("authorization");

		if (authorization) {
			authorization = Buffer.from(authorization.split("Basic ").join(""), "base64").toString('utf-8');
			authorization = authorization.split(":");

			let user = authorization.shift(1);
			let password = authorization.join("");

			auth = {user, password};
		}

		try {
			res.locals.client = await MongoDB.MongoClient.connect(config.connection, {...config.client, auth});
		} catch (err) {
			
			let message = err.message;
			if (message.includes("MongoError")) message = err.message.split("[MongoError: ")[1].split("\n")[0].split(".").join("").toLowerCase();
			
			return await error("connection_failed", {	message	}, 400, res);
		}

		next();
	})

	app.post("/_:action/", async(req, res, next) => {
		const { client } = res.locals;
		const { action } = req.params;

		try {
			let result = await client[action](...req.body);
			return res.json(await parse(result));

		} catch (err) {
			return await error("not_found", { message: err.message, action }, 404, res);
		}
	});

	app.post("/:db_name/*", async(req, res, next) => {
		const { client } = res.locals;
		const { db_name } = req.params;

		res.locals.database = client.db(db_name);
		next();
	});

	app.post("/:db_name/_:action/", async(req, res, next) => {
		const { client, database } = res.locals;
		const {	action } = req.params;

		try {
			let result = await database[action](...req.body);
			return res.json(await parse(result));

		} catch (err) {
			return await error("not_found", { message: err.message, action }, 404, res);
		}
	});

	app.post("/:db_name/:collection_name/*", async(req, res, next) => {
		const { client, database } = res.locals;
		const { collection_name } = req.params;

		res.locals.collection = database.collection(collection_name);
		next();
	});

	app.post("/:db_name/:collection_name/_:action/", async(req, res, next) => {
		const { client, database, collection } = res.locals;
		const { action } = req.params;

		try {
			let result = await collection[action](...req.body);
			return res.json(await parse(result));

		} catch (err) {
			return await error("not_found", { message: err.message,	action }, 404, res);
		}
	});

	app.post("*", async(req, res) => {
		if (res.headersSent) return;
		return await error("not_found", null, 404, res);
	})

	app.all("*", async(req, res) => {
		if (res.headersSent) return;

		return await error("method_not_allowed", {
			method: req.method.toLowerCase()
		}, 405, res);
	})


	app.listen(config.web_port, () => {
		console.log(`[${NPM_NAME}] Web server available on port ${config.web_port}.`)
	});
}

async function start(retry = true) {
	fs.readFile(CONFIG_PATH, "utf8").then(async (config) => {
		console.log(`[${NPM_NAME}] Loading "${CONFIG_PATH}".`);
		
		try {
			config = Object.assign(DEFAULT_CONFIG, JSON.parse(config));
		} catch (err) {
			console.error(`[${NPM_NAME}] Malformed configuration (${err.message}).`)
			return;
		}
		
		console.log(`[${NPM_NAME}] Loaded configuration.`);
		
		console.log(`[${NPM_NAME}] Attempting initial connection using "${config.connection}"`);
		let client = new MongoDB.MongoClient(config.connection, config.client);
		
		try {
			await client.connect();
			console.log(`[${NPM_NAME}] Initial connection successful using "${config.connection}"`);
		} catch (err) {
			console.error(`[${NPM_NAME}] Failed to connect to MongoDB instance with: "${config.connection}"`)
			return;
		}
		
		return config;
	}).then(runtime).catch(async err => {
		console.error(`[${NPM_NAME}]`, err.message);

		if (err.message.includes("no such file or directory")) {
			console.warn(`[${NPM_NAME}] Generating default configuration.`);

			await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));

			console.log(`[${NPM_NAME}] Created default configuration.`);

			if (!retry) {
				console.error(`[${NPM_NAME}] Failed to obtain configuration file after attempted creation.`);
				return;
			}

			return await start(false);
		}
	});
}

start().then(() => {
	console.log(`[${NPM_NAME}] Starting...`);
})