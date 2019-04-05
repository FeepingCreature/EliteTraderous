const inquirer = require('inquirer');
const rpn_errors = require('request-promise-native/errors');
const rpn = require('request-promise-native');
// require('request-debug')(rpn);
const fs = require('fs');
const between = require(__base+'/lib/between.js').between;
const express = require('express');
const base64url = require('base64url');
const crypto = require('crypto');
const assert = require('assert');

const EliteAPI = {
	auth_host: "https://auth.frontierstore.net",
	auth_path: '/auth',
	token_path: "/token",
	profile_url: "https://companion.orerve.net/profile",
	market_url: "https://companion.orerve.net/market",
	user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 7_1_2 like Mac OS X) AppleWebKit/537.51.2 (KHTML, like Gecko) Mobile/11D257"
};

function APIError(status) {
	this.name = "APIError";
	this.message = "" + status;
  this.status = status;
  this.stack = (new Error()).stack;
}
APIError.prototype = new Error;

function* read_console(type, msg) {
	const res = yield inquirer.prompt([{
		type: type,
		name: 'input',
		message: msg
	}]);
	return res.input;
}

function elite_api_query(url, action, post_data, session) {
	const options = {
		'method': action,
		'uri': url,
		'followRedirect': false,
		'simple': false,
		'resolveWithFullResponse': true,
		'headers': {
			'User-Agent': EliteAPI['user_agent'],
			'Authorization': 'Bearer ' + session.access_token,
		},
	};
	if (post_data) options.form = post_data;
	return new Promise(function(fulfill, reject) {
		console.log(">> "+options.method+" "+options.uri);
		if (post_data) {
			let copy = {};
			for (let key in post_data) if (post_data.hasOwnProperty(key)) copy[key] = post_data[key];
			console.log(">>> "+JSON.stringify(copy));
		}
		rpn(options).then(function(response) {
			var body = response.body;
			if (body && body.indexOf("\"errorSummary alert alert-danger\"") != -1) {
				const error = between(between(body, "\"errorSummary alert alert-danger\"", "</ul>"), "<li>", "</li>").trim();
				console.log("API Error: "+error);
				process.exit(0);
			}
			if (response.statusCode >= 400 && response.statusCode != 401) {
				console.log("API error: code " + response.statusCode);
				reject(new APIError(response.statusCode));
			}
			session.save();
			fulfill(body);
		});
	});
}

function* try_get_api(session, url) {
	if (session.stage != 'authenticated') return; // no need to try
	try {
		var obj = yield elite_api_query(url, 'get', null, session);
		if (obj.indexOf("<h1>404</h1>") != -1 || obj == "") {
			console.log("Session invalid. Resetting.");
			session.stage = null;
			return null;
		}
	}
	catch (error) {
			console.log("Resetting due to " + error);
			session.stage = null;
			return null;
	}
	return obj;
}

module.exports.Session = function() {
	this.access_token = null;
	this.refresh_token = null;
	this.stage = null;
	this.client_id = null;

	try {
		let data = JSON.parse(fs.readFileSync('session.json'));
		for (let key in data) if (data.hasOwnProperty(key)) this[key] = data[key];
	} catch (err) { }

	this.need_stage = function(stage) {
		if (stage == 'refresh') {
			if (this.stage != 'authenticated') return true;
		}
		return this.stage == stage;
	};
	this.save = function() { fs.writeFileSync('session.json', JSON.stringify(this)); };
	this.load_profile = function*() {
		return yield* this.load_api_call(EliteAPI.profile_url);
	};
	this.load_market_data = function*() {
		return yield* this.load_api_call(EliteAPI.market_url);
	};
	this.load_api_call = function*(url) {
		if (!this.client_id) {
			this.client_id = yield* read_console('input', 'Please enter your Frontier Store Client Id:');
			this.save();
		}

		const oauth2 = require('simple-oauth2').create({
			client: {
				id: this.client_id,
				secret: 'EliteTraderous',
			},
			auth: {
				tokenHost: EliteAPI.auth_host,
				tokenPath: EliteAPI.token_path,
				authorizePath: EliteAPI.auth_path,
			},
			options: {
				authorizationMethod: 'body',
			},
		});

		let accessToken = oauth2.accessToken.create({
			access_token: this.access_token,
			refresh_token: this.refresh_token,
			expires_in: '7200',
		});

		let obj = yield* try_get_api(this, url);

		if (this.need_stage('refresh') || accessToken.expired()) {
			console.log("Attempt to refresh token.");
			try {
				accessToken = yield accessToken.refresh();
				this.stage = 'authenticated';
			} catch (error) {
				console.log('Error refreshing access token: ', error);
				this.stage = 'authenticate';
			}

			this.save();
		}

		if (this.need_stage('authenticate')) {
			console.log("Authenticating app.");

			const state = base64url.encode(crypto.randomBytes(8));
			const verifier = base64url.encode(crypto.randomBytes(32));
			const redirect_uri = 'http://localhost:2392/auth';
			const authUri = oauth2.authorizationCode.authorizeURL({
				redirect_uri: redirect_uri,
				scope: 'auth capi',
				audience: 'steam,frontier',
				code_challenge: base64url.encode(
					crypto.createHash('sha256').update(verifier).digest()),
				code_challenge_method: 'S256',
				state: state,
			});
			console.log("Redirect to ", authUri);
			require('opn')(authUri);

			var server = null;
			var tokenConfig = yield new Promise(function(fulfill, reject) {
				var app = express();
				app.get('/auth', function(req, res) {
					assert.equal(req.query.state, state);
					const code = req.query.code;
					res.send('<h2>App authenticated!</h2>');
					fulfill({
						code: code,
						redirect_uri: redirect_uri,
						code_verifier: verifier,
					});
				});

				server = app.listen(2392);
			});
			console.log(" created token config " + JSON.stringify(tokenConfig));

			if (server) server.close();
			const result = yield oauth2.authorizationCode.getToken(tokenConfig);
			accessToken = oauth2.accessToken.create(result);

			this.access_token = result.access_token;
			this.refresh_token = result.refresh_token;
			this.stage = 'authenticated';
			this.save();
			console.log("Authenticated.");
		}

		if (!obj) obj = yield* try_get_api(this, url);

		// console.log("debug: "+JSON.stringify(JSON.parse(obj)));

		return JSON.parse(obj);
	};

	return this;
}
