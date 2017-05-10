global.__base = __dirname + '/';
const pg = require('pg');
const co = require('co');
const LRU = require("lru-cache")
let LRUnative;
try {
	LRUnative = require("lru-native");
} catch (ex) { }

const options = require(__base+'/lib/commander_patched.js');
const between = require(__base+'/lib/between.js').between;
const NumberBag = require(__base+'/lib/number_bag.js').NumberBag;

const config = require(__base+'/config.json');
const session = require(__base+'/lib/session.js');
const store = require(__base+'/lib/store.js');
const pool = new pg.Pool(config.db);

// find the station matching a location string
function* lookupLocation(db_store, loc) {
	if (!loc) return null;
	
	let rows;
	if (loc.indexOf("/") == -1) {
		// pure station search
		rows = yield* db_store.querySync(
			' select '+(new db_store.Station()).schema.attrString+' '
			+'from station where name ilike $1',
			['%'+loc+'%']
		);
	} else {
		const system = between(loc, "", "/"), station = between(loc, "/", "");
		rows = yield* db_store.querySync(
			' select '+(new db_store.Station()).schema.attrString+' '
			+'from station '
			+'join system on station.system_id = system.id '
			+'where system.name ilike $1 '
			+'and station.name ilike $2',
			['%'+system+'%', '%'+station+'%']
		);
	}
	var stations = [];
	for (const row of rows) stations.push(new db_store.Station(row));
	yield* db_store.Station.loadSystems(stations);
	if (stations.length == 0) {
		throw new Error("No station found for '"+loc+"'");
	}
	if (stations.length > 1) {
		const station_names = [];
		for (const station of stations) {
			station_names.push(station.system.name.toUpperCase()+"/"+station.name);
		}
		throw new Error("Multiple stations matched '"+loc+"': "+station_names.join(", "));
	}
	return stations[0];
}

const SystemStationCache = Object.create(null);

// system ids reachable with some number of jumps starting from one system
function JumpSet(jumpsPer) {
	this.bags = new Array(jumpsPer + 1);
	this.setSystems = function(jumps, systems) {
		this.bags[jumps] = new NumberBag(systems);
	};
	this.findJumpsFor = function(system_id) {
		for (let jumps = 0; jumps <= jumpsPer; jumps++) {
			if (this.bags[jumps].contains(system_id)) return jumps;
		}
		console.log("Impossible!! no "+system_id+" in "+JSON.stringify(this)+"??");
		process.exit(1);
	};
}

// return map of systems (with stations) reachable from <system> with <jumps> jumps.
// if <inclusive> is true, include each system in the subsequent jump maps, ie. if
// system1 is reachable in 1 jump, it also counts as reachable in 2, 3 and 4 jumps.
function* lookupSystemRangeMap(db_store, options, num_jumps, inclusive, system) {
	const System = new db_store.System;
	
	let systems = Object.create(null);
	systems[system.id] = system;
	
	let jumps = new JumpSet(num_jumps);
	jumps.setSystems(0, [+system.id]);
	
	let jump_ids = [];
	for (let i = 0; i < num_jumps; i++) {
		const isLastJump = i == num_jumps - 1;
		const onlySystemsWithStations = isLastJump;
		const new_systems = yield* System.findInRange(systems, options.lyPer, onlySystemsWithStations);
		if (!inclusive) jump_ids = [];
		for (const key in new_systems) if (typeof systems[key] == 'undefined') { // only reachable with i+1 jumps
			jump_ids.push(+key);
		}
		systems = new_systems;
		jumps.setSystems(i + 1, jump_ids);
	}
	return [systems, jumps];
}

// get all systems/stations reachable from <system> with the jump/ly settings in <options>
function* lookupSystemsWithStationsInRange(db_store, options, system) {
	const [systems, jumps] = yield* lookupSystemRangeMap(db_store, options, options.jumpsPer, false, system);
	const Station = new db_store.Station;
	
	const systems_stations = {};
	const system_ids = [];
	for (const key in systems) {
		if (typeof SystemStationCache[key] !== 'undefined') {
			systems[key].stations = SystemStationCache[key];
		} else {
			system_ids.push(key);
			systems[key].stations = SystemStationCache[key] = {}; // will be filled in below
		}
	}
	
	if (system_ids.length) {
		const filter = {system_id: system_ids};
		if (options.padSize == 'L') filter['max_landing_pad_size'] = 'L';
		else if (options.padSize == 'M') filter['max_landing_pad_size'] = ['L', 'M'];
		if (!options.planets) filter['is_planetary'] = false;
			
		stations = yield* Station.findAll(filter);
		for (const key in stations) {
			stations[key].system = systems[stations[key].system_id];
			SystemStationCache[stations[key].system_id][stations[key].id] = stations[key];
		}
	}
	return [systems, jumps];
}

// cache results of a given generator function
function FunctionCache() {
	if (LRUnative) this.map = new LRUCache({ maxElements: config.cachesize });
	else this.map = LRU(config.cachesize);
	this.ize = function*(key, fn) {
		var entry = this.map.get(key);
		if (entry) return entry;
		const res = yield* fn();
		this.map.set(key, res);
		return res;
	};
}

const lookupLocationMemo = new FunctionCache();
function* lookupLocationCached(db_store, loc) {
	return yield* lookupLocationMemo.ize(loc, lookupLocation.bind(this, db_store, loc));
}

const lookupSystemsWithStationsInRangeMemo = new FunctionCache();
function* lookupSystemsWithStationsInRangeCached(db_store, options, system) {
	const key = system.id;
	return yield* lookupSystemsWithStationsInRangeMemo.ize(key, lookupSystemsWithStationsInRange.bind(this, db_store, options, system));
}

// model to estimate how long a trade will take to execute
function estimateTiming(trade) {
	const timings = config.timings;
	
	let res = 0;
	res += timings.timePerResourceTrade * trade.num_trades; // buy
	res += timings.timeToLeave; // depart
	res += timings.timeInHyperspace * trade.num_jumps; // jump
	res += timings.timeBetweenJumps * trade.num_jumps; // cooldown
	let distance_to_star = trade.to.distance_to_star;
	if (distance_to_star == null) distance_to_star = 100;
	res += 30 + ((Math.log(distance_to_star) - 1) / 5) * 100 + 0.002 * distance_to_star; // heuristic
	res += timings.timeToLand; // land on station
	res += timings.timeInStation; // bring up menus, watch animations
	res += timings.timePerResourceTrade * trade.num_trades; // sell
	return res;
}

// object representing a single trade, buy to sell
function Trade(station1, station2, key, gain, stock, num_jumps, num_trades) {
	this.from = station1;
	this.to = station2;
	this.key = key;
	this.gain = gain;
	this.stock = stock;
	this.num_jumps = num_jumps;
	this.num_trades = num_trades;
	this.flight_time = estimateTiming(this);
	this.betterThan = function(trade2) {
		if (!trade2) return true;
		return this.gain > trade2.gain;
	};
	this.toString = function() {
		return this.from.prettyName()+" -> "+this.to.prettyName()+" ["+this.key+" +"+this.gain.toLocaleString()+"]";
	};
}

const stationTradesMemo = new FunctionCache();

// separate function to allow vm optimization
function findBestTrade_rest(station1, station2, options, num_jumps, trades1, trades2) {
	const trade1_comm = Object.create(null), trade2_comm = Object.create(null);
	for (var key in trades1) {
		trade1_comm[trades1[key].name] = trades1[key];
	}
	for (var key in trades2) {
		const name = trades2[key].name;
		if (typeof trade1_comm[name] !== 'undefined' && typeof options._excludeMap[name] === 'undefined') {
			trade2_comm[name] = trades2[key];
		}
	}
	let capLeft = options.cap;
	const trades = [];
	const stockOverlay = Object.create(null);
	while (capLeft && trades.length < 4) {
		let bestTrade = null;
		for (var key in trade2_comm) {
			const buy = trade1_comm[key];
			const sell = trade2_comm[key];
			let buystock = buy.stock;
			if (typeof stockOverlay[key] !== 'undefined') buystock = stockOverlay[key];
			const numTrade = Math.min(capLeft, buystock);
			const trade = new Trade(station1, station2, key, numTrade * (sell.sellPrice - buy.buyPrice), numTrade, num_jumps, 1);
			if (trade.betterThan(bestTrade)) bestTrade = trade;
		}
		if (!bestTrade || !bestTrade.stock/* || bestTrade.gain < 0*/) break;
		if (!(bestTrade.key in stockOverlay)) stockOverlay[bestTrade.key] = trade1_comm[bestTrade.key];
		
		stockOverlay[bestTrade.key] -= bestTrade.stock;
		capLeft -= bestTrade.stock;
		trades.push(bestTrade);
	}
	// if (trades.length == 0) return new Trade(station1, station2, "Nothing", 0, 0, num_jumps, 0);
	if (trades.length == 0) return null;
	if (trades.length == 1) return trades[0];
	let sum_gain = 0, sum_trade = 0;
	const composite_key = trades.map(function(trade) { sum_gain += trade.gain; sum_trade += trade.stock; return trade.key+" ("+trade.stock+")"; }).join(", ");
	return new Trade(station1, station2, composite_key, sum_gain, sum_trade, num_jumps, trades.length);
}

function* findBestTrade(db_store, station1, station2, options, num_jumps) {
	const Trade_model = new db_store.Trade();
	const trades1 = yield* stationTradesMemo.ize(station1.id+"@buy", function*() {
		return yield* Trade_model.findAll({ station_id: station1.id, buyPrice: store.SqlNotNull });
	});
	const trades2 = yield* stationTradesMemo.ize(station2.id+"@sell", function*() {
		return yield* Trade_model.findAll({ station_id: station2.id, sellPrice: store.SqlNotNull });
	});
	return findBestTrade_rest(station1, station2, options, num_jumps, trades1, trades2);
}

// separate function to allow vm optimization
function sampleHop_getNextStation(systems, jumps, forceTargetBag, forceTargetStation) {
	if (forceTargetBag) {
		const systems2 = Object.create(null);
		for (const target_id of forceTargetBag.values()) {
			if (typeof systems[target_id] !== 'undefined') systems2[target_id] = systems[target_id];
		}
		systems = systems2;
	}
	
	if (forceTargetStation) {
		for (const key in systems) {
			if (typeof systems[key].stations[forceTargetStation] !== 'undefined') {
				return systems[key].stations[forceTargetStation];
			}
		}
		console.log("target station "+forceTargetStation+" not found in systems "+Object.keys(systems).join(", "));
		return null;
	} else {
		const system_keys = Object.keys(systems);
		if (!system_keys.length) return null;
		
		const index1 = Math.floor(Math.random() * system_keys.length);
		const system = systems[system_keys[index1]];
		
		const station_keys = Object.keys(system.stations);
		if (!station_keys.length) return null;
		const index2 = Math.floor(Math.random() * station_keys.length);
		return system.stations[station_keys[index2]];
	}
}

const FindBestTradeMemo = new FunctionCache();

// get a random next station reachable from <station>.
// may be constrained to a certain system or station.
// returns null if it can't find a match.
function* sampleHop(db_store, station, options, forceTargetBag, forceTargetStation) {
	const [systems, jumps] = yield* lookupSystemsWithStationsInRangeCached(db_store, options, station.system);
	const next_station = sampleHop_getNextStation(systems, jumps, forceTargetBag, forceTargetStation);
	if (next_station == null) return null;
	// const num_jumps = jumps.findJumpsFor(next_station.system.id);
	// const trade = yield* findBestTrade(db_store, station, next_station, options, num_jumps);
	const trade = yield* FindBestTradeMemo.ize(station.id+">"+next_station.id, function*() {
		const num_jumps = jumps.findJumpsFor(next_station.system.id);
		return yield* findBestTrade(db_store, station, next_station, options, num_jumps);
	});
	return trade;
}

// a route is a bunch of trades that can be executed in sequence.
function Route(trades) {
	this.trades = trades;
	this.length = trades.length;
	this.sum_gain = 0;
	this.sum_flight_time = 0;
	for (const trade of this.trades) {
		this.sum_gain += trade.gain;
		this.sum_flight_time += trade.flight_time;
	}
	this.gain_per_sec = this.sum_flight_time ? (this.sum_gain / this.sum_flight_time) : 0;
}

Route.prototype.betterThan = function(route2) {
	if (!route2) return true;
	return this.gain_per_sec > route2.gain_per_sec;
};

Route.prototype.toString = function() {
	const gain_per_time = this.sum_flight_time?(this.sum_gain / this.sum_flight_time):0;
	return this.trades.map(function(trade) { return trade.toString(); }).join("\n ")
	+'\n  -- gain +'+this.sum_gain.toLocaleString()+'cr over '+Math.floor(this.sum_flight_time).toLocaleString()+'s estimated: '
	+Math.floor(gain_per_time).toLocaleString()+"cr/s";
};

// create a route by random search
function* sample(db_store, options) {
	const trades = [];
	const startStation = yield* lookupLocationCached(db_store, options.from);
	const endStation = yield* lookupLocationCached(db_store, options.to);
	let station = startStation;
	for (let i = 0; i < options.hops; i++) {
		let overrideTarget;
		if (endStation != null && i == options.hops - 1) overrideTarget = endStation.id;
		const hopsFromEnd = options.hops - 1 - i;
		const jumpsFromEnd = hopsFromEnd * options.jumpsPer;
		let overrideBag = null;
		if (options._backwardConstraintSet != null && jumpsFromEnd in options._backwardConstraintSet.bags) {
			overrideBag = options._backwardConstraintSet.bags[jumpsFromEnd];
		}
		let trade = yield* sampleHop(db_store, station, options, overrideBag, overrideTarget);
		if (!trade) return null;
		trades.push(trade);
		station = trade.to;
	}
	return new Route(trades);
}

// create a route by changing a single step
function* mutate(db_store, options, route) {
	if (route.length < 2) return null;
	
	const redo_index = Math.floor(Math.random() * (route.length - 1));
	// trade 0 is 0-1, trade 1 is 1-2
	// to redo trade n, generate a new hop for n, then a successor constrained to the <to> of n+1
	const trades = route.trades.slice(0);
	
	const [_bogus, jumps] = yield* lookupSystemRangeMap(db_store, options, options.jumpsPer, true, trades[redo_index+1].to.system);
	
	let trade1 = yield* sampleHop(db_store, trades[redo_index].from, options, jumps.bags[options.jumpsPer]);
	if (!trade1) return null; // no trades found
	
	let trade2 = yield* sampleHop(db_store, trade1.to, options, null, trades[redo_index+1].to.id);
	if (!trade2) return null; // no trades found
	
	trades[redo_index] = trade1;
	trades[redo_index + 1] = trade2;
	
	return new Route(trades);
}

// create a route by sampling, then swapping steps until we stop finding easy improvements
// we don't call mutate in the main search, because the route thus created would be
// effectively unbeatable by the purely-random search, meaning none of the random routes
// would get to benefit from mutations.
function* refine(db_store, options) {
	let bestRoute = yield* sample(db_store, options);
	if (!bestRoute) return [null, 0];
	
	let k = 0;
	for (let i = 0; i < 128; i++, k++) {
		let route;
		if (k < 128) route = yield* sample(db_store, options); // find a reasonable route to start
		else route = yield* mutate(db_store, options, bestRoute); // then refine it further
		
		if (!route) continue;
		if (route.betterThan(bestRoute)) {
			bestRoute = route;
			i = 0;
		}
	}
	return [bestRoute, k];
}

co(function*() {
	const client = yield pool.connect();
	const db_store = new store.Store(client);
	
	options.planets = true; // default on
	
	for (key in config.defaultOptions) if (config.defaultOptions.hasOwnProperty(key)) {
		options[key] = config.defaultOptions[key];
	}
	
	options
		.version(require(__base+'/package.json').version)
		.optionRequired('--ly-per <n>', "Lightyears per jump (minimum)", parseInt)
		// .optionRequired('--cr <n>', "Credits budget for trading", parseInt)
		.optionRequired('--cap <n>', "Cargo capacity available", parseInt)
		.option('--from <text>', "Starting location")
		.option('--to <text>', "Target location")
		.option('--loop', "Return to the starting station")
		.option('--pad-size <text>', "Minimum pad size on the station")
		.option('--jumps-per <n>', "Maximum number of jumps from system to system")
		.option('--hops <n>', "Hops to search for", parseInt)
		.option('--max-hops <n>', "Max number of hops to search for", parseInt)
		.option('--import', "Import trade info at startup. --from will default to the current station.")
		.option('--no-planets', "Don't consider planetary stations.")
		.option('--run-for <n>', "Instead of searching forever, run for <n> seconds and then exit.")
		.option('--exclude <text>', "Excludes the good from trading", function(v, a) { a.push(v); return a; }, [])
		.parse(process.argv);
	
	if (options.loop) options.to = options.from;
	if (options.hops && options.maxHops) {
		options.errorWithStyle("conflicting flags, --max-hops overrides the effect of --hops.");
	}
	if (!options.hops) options.hops = 1;
	if (!options.jumpsPer) options.jumpsPer = 1;
	
	options._excludeMap = Object.create(null);
	for (const exclude of options.exclude) options._excludeMap[exclude] = true;
	
	if (options.import) {
		const session_obj = new session.Session();
		const profile = yield* session_obj.load_profile();
		yield* db_store.Trade.import_profile(profile);
		
		if (options.from == null) {
			options.from = profile.lastSystem.name+"/"+profile.lastStarport.name;
		}
	}
	
	if (!options.from) {
		options.errorWithStyle(function() {
			options.errorRequiredOptionMissing('from');
		});
	};
	
	const startStation = yield* lookupLocationCached(db_store, options.from);
	const endStation = yield* lookupLocationCached(db_store, options.to);
	
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
		const [route, k] = yield* refine(db_store, options);
		if (!route) continue;
		const timeSinceStart = (time() - startTime)/1000;
		if (route.betterThan(bestRoute)) {
			if (!options.runFor) {
				console.log("After "+Math.floor(timeSinceStart)+"s: Improve to:  ("+Math.floor(count*1000/(time() - lastImproveTime))+"/s)");
				console.log(route.toString());
			}
			lastImproveTime = time();
			count = 0;
			bestRoute = route;
		}
		// find at least *any* route before stopping
		if (bestRoute && timeSinceStart > options.runFor) break;
		count += k;
	}
	
	console.log(bestRoute.toString());
	
	process.exit(0);
}).catch(function(err) {
	console.error(err.stack);
	process.exit(1);
});
