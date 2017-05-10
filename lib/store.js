const pg = require('pg');
const FlushWritable = require('flushwritable');
const util = require('util');
const ProgressBar = require('progress');
const Model_js = require(__base+'/lib/model.js');
const config = require(__base+'/config.json');
const pool = new pg.Pool(config.db);

module.exports.SqlExpression = Model_js.SqlExpression;
module.exports.SqlNotNull = Model_js.SqlNotNull;

const Model = Model_js.Model;

module.exports.Store = function(client) {
	const store = this;
	
	this.progress = 0;
	this.expected_records = null;
	this.onProgress = null;
	this.queries = [];
	this.insert_cache = Object.create(null);
	this.save_flush = function() {
		for (let key in this.insert_cache) {
			this.insert_cache[key].flush();
		}
	};
	this.setup_bar = function() {
		let bar = new ProgressBar('Database [:bar] :rate/s :percent :etas', {
			complete: '*',
			incomplete: '.',
			clear: true,
			width: 50,
			total: this.expected_records
		});
		let last_bar = 0;
		this.onProgress = function() {
			let delta = this.progress - last_bar;
			last_bar = this.progress;
			bar.tick(delta);
		};
		return function() {
			bar.tick(this.expected_records - last_bar); // set to full
			this.onProgress = null;
			this.progress = 0;
			this.expected_records = null;
		}.bind(this);
	};
	this.flush = function*() {
		this.save_flush();
		
		let remove_bar;
		if (this.expected_records) remove_bar = this.setup_bar();
		
		yield this.queries;
		
		if (remove_bar) remove_bar();
		this.queries.length = 0;
	};
	this.FlushStream = function(process) {
		FlushWritable.call(this, { objectMode: true });
		let remove_bar;
		if (store.expected_records) remove_bar = store.setup_bar();
		this._write = function write(obj, encoding, callback) {
			process(obj);
			if (store.queries.length) {
				Promise.all(store.queries).then(function() { callback(); });
				store.queries.length = 0;
			}
			else callback(); // buffered in insert cache or similar
		};
		this._flush = function(callback) {
			store.save_flush();
			if (store.queries.length) {
				Promise.all(store.queries).then(function() { if (remove_bar) remove_bar(); callback(); });
				store.queries.length = 0;
			}
			else {
				if (remove_bar) remove_bar();
				callback(); // nothing to flush
			}
		};
	};
	util.inherits(this.FlushStream, FlushWritable);
	
	this.execute = function(sql, vars, options) {
		// console.log("> "+sql+"  "+JSON.stringify(vars));
		let chunks = 1;
		if (options && options.chunks) chunks = options.chunks; // how many "steps at once" this query represents
		
		const afterQuery = function(value) { this.progress += chunks; if (this.onProgress) this.onProgress(); return Promise.resolve(value); };
		this.queries.push(client.query(sql, vars).then(afterQuery.bind(this)));
		if (!this.onProgress) this.expected_records += chunks;
	};
	this.executeSync = function*() {
		this.execute.apply(this, arguments);
		yield* this.flush();
	};
	this.querySync = function*() {
		// console.log("> "+arguments[0]+"  "+JSON.stringify(arguments[1]));
		let query = client.query.apply(client, arguments);
		let res = yield query;
		return res.rows;
	}
	
	this.System = function(obj) {
		this.setAttributes(obj);
	};
	Model.defineModel(this.System, store, 'system', 'id', {
		id: Model.Type.BigInt,
		name: Model.Type.Text,
		position: Model.Type.Position,
		needs_permit: Model.Type.Bool
	});
	this.System.prototype.findInRange = function*(systems, range, onlyWithStations) {
		let sql =
			' select '+this.schema.attrString+' '
			+'from system ';
		let subsql = 'false ';
		const values = [];
		const pushfn = Model_js.sqlPushFunction(values);
		const min = {x: Infinity, y: Infinity, z: Infinity};
		const max = {x: -Infinity, y: -Infinity, z: -Infinity};
		for (const key in systems) {
			const system = systems[key];
			const pos = system.position;
			min.x = Math.min(min.x, pos.x); min.y = Math.min(min.y, pos.y); min.z = Math.min(min.z, pos.z);
			max.x = Math.max(max.x, pos.x); max.y = Math.max(max.y, pos.y); max.z = Math.max(max.z, pos.z);
			subsql += 'or cube_distance('+Model.Type.Position.toSql(pos, pushfn)+', position) < '+pushfn(range)+' ';
		}
		sql += 'where position <@ cube_enlarge('+Model.Type.Cube.toSql({from: min, to: max}, pushfn)+', '+pushfn(range)+', 3) ';
		sql += 'and ('+subsql+') ';
		if (onlyWithStations) sql += 'and exists (select 1 from station where system_id = system.id) ';
		var rows = yield* store.querySync(sql, values);
		const res = Object.create(null);
		for (const row of rows) {
			res[row[this.schema.pk]] = new this.constructor(row);
		}
		return res;
	};
	
	
	this.Station = function(obj) {
		this.setAttributes(obj);
	};
	Model.defineModel(this.Station, store, 'station', 'id', {
		id: Model.Type.BigInt,
		system_id: Model.Type.BigInt,
		name: Model.Type.Text,
		max_landing_pad_size: Model.Type.Text,
		distance_to_star: Model.Type.Integer,
		has_market: Model.Type.Bool,
		is_planetary: Model.Type.Bool,
		updated_at: Model.Type.Timestamp
	});
	this.Station.prototype.prettyName = function() {
		return this.system.name.toUpperCase()+"/"+this.name;
	};
	this.Station.prototype.getByNames = function*(system_name, station_name) {
		var rows = yield* store.querySync(
			' select '+this.schema.attrString+' '
			+'from station inner join system on station.system_id = system.id '
			+'where system.name = $1 and station.name = $2',
			[system_name, station_name]
		);
		// console.log("search station "+system_name+"/"+station_name+": "+rows.length);
		if (!rows.length) return null;
		var row = rows[0];
		return new store.Station(row);
	};
	this.Station.loadSystems = function*(stations) {
		let systems = Object.create(null);
		for (const station of stations) systems[station.system_id] = true;
		systems = yield* (new store.System).findAllByPks(Object.keys(systems));
		for (const station of stations) station.system = systems[station.system_id];
	};
	
	this.Trade = function(obj) {
		if (obj && obj.buyPrice == 0) obj.buyPrice = null;
		if (obj && obj.sellPrice == 0) obj.sellPrice = null;
		this.setAttributes(obj);
	};
	Model.defineModel(this.Trade, store, 'trade', 'pk', {
		pk: Model.Type.BigInt,
		station_id: Model.Type.BigInt,
		id: Model.Type.BigInt,
		name: Model.Type.Text,
		buyPrice: Model.Type.Integer,
		sellPrice: Model.Type.Integer,
		stock: Model.Type.Integer
	});
	this.Trade.prototype.schema.pk_conflict = 'station_id, name'; // pseudo pk
	this.Trade.import_profile = function*(profile) {
		let station = yield* (new store.Station).getByNames(profile.lastSystem.name, profile.lastStarport.name);
		if (!station) {
			console.log("WARN: station not found when importing: "+profile.lastStarport.name);
			return;
		}
		station.updated_at = new Model_js.SqlExpression("NOW()");
		station.save();
		station.system = yield* (new store.System).findByPk(station.system_id);
		
		let commodities = profile.lastStarport.commodities;
		for (let commodity of commodities) {
			let trade = new store.Trade({
				station_id: station.id,
				id: commodity.id,
				name: commodity.name,
				buyPrice: commodity.buyPrice,
				sellPrice: commodity.sellPrice,
				stock: Math.floor(commodity.stock)
			});
			trade.save();
		}
		console.log(commodities.length+" commodities imported in "+station.prettyName());
		yield* store.flush();
	};
	this.create_tables = function*() {
		yield* this.executeSync(' create extension if not exists cube ');
		
		yield* this.executeSync(' drop index if exists system_position_index ');
		yield* this.executeSync(' drop index if exists station_system_id_index ');
		
		yield* this.executeSync(' drop table if exists trade ');
		yield* this.executeSync(' drop table if exists station ');
		yield* this.executeSync(' drop table if exists system ');
		
		yield* this.executeSync(' create table system ( '
			+' id bigint primary key, '
			+' name text not null, '
			+' position cube not null, '
			+' needs_permit bool not null '
		+' ) ');
		yield* this.executeSync(' create index system_position_index on system using gist(position); ');
		
		yield* this.executeSync(' create table station ( '
			+' id bigint primary key, '
			+' system_id bigint references system(id), '
			+' name text not null, '
			+" max_landing_pad_size text check (max_landing_pad_size in ('M', 'L', 'None')), "
			+' distance_to_star integer, '
			+' has_market bool not null, '
			+' is_planetary bool not null, '
			+' updated_at timestamp default null '
		+' ) ');
		yield* this.executeSync(' create index station_system_id_index on station(system_id); ');
		
		yield* this.executeSync(' create table trade ( '
			+' pk serial primary key, '
			+' station_id bigint references station(id), '
			+' id bigint, '
			+' name text not null, '
			+' "buyPrice" integer, '
			+' "sellPrice" integer, '
			+' stock integer not null, '
			+' unique(station_id, name) ' // TODO check if (station_id, id) is correct
		+' ) ');
	};
};
