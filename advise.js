global.__base = __dirname + '/';

const co = require('co');

const config = require(__base+'/config.json');
const options = require(__base+'/lib/commander_patched.js');
const session = require(__base+'/lib/session.js');
const store = require(__base+'/lib/store.js');
const trade = require(__base+'/trade.js');

co(function*() {
	function* say(msg) {
		const say = require('say');
		yield new Promise(function(resolve, reject) {
			console.log("~ " + msg);
			say.speak(msg, null, 1, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	const db_store = new store.Store();

	yield* db_store.connect();

	options.planets = true; // default on
	options.exclude = [];
	options.runFor = 10;
	options.minTime = 1000;

	if (!options.hops) options.hops = 1;
	if (!options.jumpsPer) options.jumpsPer = 1;

	for (key in config.defaultOptions) if (config.defaultOptions.hasOwnProperty(key)) {
		options[key] = config.defaultOptions[key];
	}

	options._excludeMap = Object.create(null);
	for (const exclude of options.exclude) options._excludeMap[exclude] = true;

	const session_obj = new session.Session();
	const profile = yield* session_obj.load_profile();
	// require('fs').writeFileSync("profile.json", JSON.stringify(profile, null, 2));

	function* jumpAdvice(prefix = "") {
		function nato(text) {
			phoneticAlphabet = {
				A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo',
				F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett',
				K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar',
				P: 'Papa', Q: 'Qebec', R: 'Romeo', S: 'Sierra', T: 'Tango',
				U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-Ray',
				Y: 'Yankee', Z: 'Zulu', ' ': 'Space',
			};
			var result = '';
			for (const character of text.toUpperCase()) {
				if (character in phoneticAlphabet) {
					result += phoneticAlphabet[character] + '; ';
				}
				else {
					result += character + '; ';
				}
			}
			return result;
		}

		let chosenRoute = session_obj.chosenRoute;
		if (!chosenRoute) {
			yield* say("No known route.");
			process.exit(0);
		}
		yield* say(prefix + " jump to " + chosenRoute.to.system +
			"; that is " + nato(chosenRoute.to.system) +
			" and dock with " + chosenRoute.to.station);
	}
	if (!profile.commander.docked) {
		yield* jumpAdvice();
		process.exit(0);
	}

	// yield* say("Planning from " + profile.lastSystem.name + "; " + profile.lastStarport.name);
	yield* say("Planning...");

	if (options.import) {
		yield* db_store.Trade.import(profile, session_obj);

		if (options.from == null) {
			options.from = profile.lastSystem.name+"/"+profile.lastStarport.name;
		}
	}
	if (options.loop) options.to = options.from;

	const startStation = yield* trade.lookupLocationCached(db_store, options.from);
	const endStation = yield* trade.lookupLocationCached(db_store, options.to);

	options._backwardConstraintMap = null;
	if (options.to) {
		const [systems, jumps] = yield* lookupSystemRangeMap(db_store, options, Math.min(4, options.jumpsPer * options.hops), true, endStation.system);
		options._backwardConstraintSet = jumps;
	}

	console.log("Searching for trades...");

	let count = 0;
	let bestRoute = null;
	function time() { return (new Date()).getTime(); }
	let lastImproveTime = time(), startTime = time();
	while (true) {
		if (options.maxHops) options.hops = Math.floor(Math.random() * (options.maxHops + 1)); // lol
		const [route, k] = yield* trade.refine(db_store, options);
		if (!route) continue;
		const timeSinceStart = (time() - startTime)/1000;
		if (route.betterThan(bestRoute)) {
			console.log("After "+Math.floor(timeSinceStart)+"s: Improve to: ("+Math.floor(count*1000/(time() - lastImproveTime))+"/s)");
			console.log(route.toString());

			lastImproveTime = time();
			count = 0;
			bestRoute = route;
		}
		// find at least *any* route before stopping
		if (bestRoute && timeSinceStart > options.runFor) break;
		count += k;
	}

	const stationFrom = bestRoute.trades[0].from;
	const stationTo = bestRoute.trades[0].to;

	session_obj.chosenRoute = {
		from: { system: stationFrom.system.name, station: stationFrom.name },
		to: { system: stationTo.system.name, station: stationTo.name },
		key: bestRoute.trades[0].key,
	};

	console.log("Chosen route: " + JSON.stringify(session_obj.chosenRoute));

	session_obj.save();

	yield* say("Route found.");
	for (var name of Object.keys(session_obj.chosenRoute.key)) {
		const count = session_obj.chosenRoute.key[name];
		const category = yield* db_store.Category.get(name);
		if (category) {
			yield* say("Buy " + count + " of " + category + "; " + name + ". ");
		}
		else {
			yield* say("Buy " + count + " of " + name + ". ");
		}
	}
	yield* jumpAdvice("Then");
	yield* jumpAdvice(";; Repeat");
});
