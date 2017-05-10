const inquirer = require('inquirer');
const rpn_errors = require('request-promise-native/errors');
const rpn = require('request-promise-native');
// require('request-debug')(rpn);
const tough = require('tough-cookie');
const fs = require('fs');
const between = require(__base+'/lib/between.js').between;

const EliteAPI = {
	login_url: "https://companion.orerve.net/user/login",
	confirm_url: "https://companion.orerve.net/user/confirm",
	profile_url: "https://companion.orerve.net/profile",
	user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 7_1_2 like Mac OS X) AppleWebKit/537.51.2 (KHTML, like Gecko) Mobile/11D257"
};

function* read_console(type, msg) {
	const res = yield inquirer.prompt([{
		type: type,
		name: 'input',
		message: msg
	}]);
	return res.input;
}

function elite_api_query(url, action, post_data, session) {
	const cookiejar = rpn.jar();
	const cookies = session['session_cookies'];
	for (var key in cookies) if (cookies.hasOwnProperty(key)) {
		cookiejar.setCookie(new tough.Cookie({
			key: key,
			value: cookies[key]
		}), url);
	}
	
	const options = {
		'jar': cookiejar,
		'method': action,
		'uri': url,
		'followRedirect': false,
		'simple': false,
		'resolveWithFullResponse': true,
		'headers': { 'User-Agent': EliteAPI['user_agent'] }
	};
	if (post_data) options.form = post_data;
	return new Promise(function(fulfill, reject) {
		rpn(options).then(function(response) {
			var body = response.body;
			if (body && body.indexOf("\"errorSummary alert alert-danger\"") != -1) {
				const error = between(between(body, "\"errorSummary alert alert-danger\"", "</ul>"), "<li>", "</li>").trim();
				console.log("API Error: "+error);
				process.exit(0);
			}
			if (response.statusCode >= 400) {
				console.log("API Error: "+JSON.stringify(response));
				process.exit(0);
			}
			session.session_cookies = {};
			// console.log("cookies: "+JSON.stringify(cookiejar.getCookies(url)));
			for (var cookie of cookiejar.getCookies(url)) {
				// console.log("cookie: "+cookie.key+" = "+cookie.value);
				session.session_cookies[cookie.key] = cookie.value;
			}
			session.save();
			fulfill(body);
		});
	});
}

function* try_get_profile(session) {
	if (session.stage != 'logged_in') return; // no need to try, because not logged in
	var profile = yield elite_api_query(EliteAPI.profile_url, 'get', null, session);
	if (profile.indexOf("<h1>404</h1>") != -1) {
		console.log("Session invalid. Resetting.");
		session.stage = null;
		return null;
	}
	return profile;
}

module.exports.Session = function() {
	this.email = null;
	this.stage = null;
	
	try {
		let data = JSON.parse(fs.readFileSync('session.json'));
		for (let key in data) if (data.hasOwnProperty(key)) this[key] = data[key];
	} catch (err) { }
	
	this.need_stage = function(stage) {
		if (stage == 'login') {
			if (!this.stage) return true;
		}
		return this.stage == stage;
	};
	this.save = function() { fs.writeFileSync('session.json', JSON.stringify(this)); };
	this.load_profile = function*() {
		if (!this.email) {
			this.email = yield* read_console('input', 'Please enter your Email:');
			this.save();
		}
		let profile = yield* try_get_profile(this);
		
		if (this.need_stage('login')) {
			console.log("Attempt to acquire login session.");
			const passwd = yield* read_console('password', 'Please enter your password (will not be saved):');
			const post_data = {
				'email': this.email,
				'password': passwd
			};
			yield elite_api_query(EliteAPI.login_url, 'post', post_data, this);
			
			this.stage = 'confirm';
			this.save();
		}
		
		if (this.need_stage('confirm')) {
			console.log("Attempt to confirm login.");
			const code = yield* read_console('input', 'Please enter the security code you just received:');
			const post_data = {
				'code': code
			};
			yield elite_api_query(EliteAPI.confirm_url, 'post', post_data, this);
			this.stage = 'logged_in';
			this.save();
		}
		
		console.log("Logged in.");
		
		if (!profile) profile = yield elite_api_query(EliteAPI.profile_url, 'get', null, this);
		
		return JSON.parse(profile);
	};
	
	return this;
}
