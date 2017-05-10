const pg = require('pg');
const util = require('util');
const ProgressBar = require('progress');
const config = require(__base+'/config.json');
const pool = new pg.Pool(config.db);

function SqlExpression(sql) {
	this.sql = sql;
}

module.exports.SqlExpression = SqlExpression;

function SqlNotNull_() { }
module.exports.SqlNotNull = new SqlNotNull_;

function sqlPushFunction(values_array) {
	return function(value) {
		if (value == null) return "NULL";
		if (value instanceof SqlExpression) {
			return value.sql;
		}
		
		// only enable for debugging!
		// if (typeof value == 'string') return "'"+value+"'";
		// return value;
		
		values_array.push(value);
		return "$"+values_array.length;
	};
}
module.exports.sqlPushFunction = sqlPushFunction;

module.exports.Model = Model = function() {
	for (let key in this.schema.attributes) if (this.schema.attributes.hasOwnProperty(key)) {
		this[key] = this.schema.attributes[key].getDefault();
	}
};

Model.prototype.setAttributes = function(attrs) {
	if (!attrs) return;
	for (var key in attrs) if (attrs.hasOwnProperty(key)) {
		if (!(this.schema.attributes.hasOwnProperty(key))) throw("Cannot set "+key+": attribute not in model!");
		this[key] = this.schema.attributes[key].fromSql(attrs[key]);
	}
};

Model.prototype.findByPk = function*(pk) {
	const rows = yield* this.store.querySync(
		' select '+this.schema.attrString+' '
		+'from "'+this.schema.tableName+'" '
		+'where "'+this.schema.pk+'" = $1',
		[pk]
	);
	return new this.constructor(rows[0]);
}

Model.prototype.findAllByPks = function*(pks) {
	if (!pks.length) return Object.create(null);
	const inList = [], inValues = [];
	for (const pk of pks) {
		inValues.push(pk);
		inList.push("$"+inValues.length);
	}
	const rows = yield* this.store.querySync(
		' select '+this.schema.attrString+' '
		+'from "'+this.schema.tableName+'" '
		+'where "'+this.schema.pk+'" in ('+inList.join(',')+')',
		inValues
	);
	const res = Object.create(null);
	for (const row of rows) {
		res[row[this.schema.pk]] = new this.constructor(row);
	}
	return res;
};

Model.prototype.findAll = function*(conditions) {
	const inValues = [];
	const pushfn = sqlPushFunction(inValues);
	let sql =
		' select '+this.schema.attrString+' '
		+'from "'+this.schema.tableName+'" '
		+'where true '; // makes "and where" easier
	for (const key in conditions) if (conditions.hasOwnProperty(key)) {
		const value = conditions[key];
		if (value && typeof value[Symbol.iterator] === 'function') {
			const inList = [];
			for (const subvalue of value) {
				inList.push(this.schema.attributes[key].toSql(subvalue, pushfn));
			}
			sql += 'and "'+key+'" in ('+inList.join(', ')+') ';
		} else {
			if (value instanceof SqlNotNull_) {
				sql += 'and "'+key+'" is not null ';
			} else {
				sql += 'and "'+key+'" = '+this.schema.attributes[key].toSql(value, pushfn)+' ';
			}
		}
	}
	const rows = yield* this.store.querySync(sql, inValues);
	const res = Object.create(null);
	for (const row of rows) {
		res[row[this.schema.pk]] = new this.constructor(row);
	}
	return res;
};

Model.prototype.save = function() {
	const schema = this.schema;
	const tableName = schema.tableName;
	const attrs = [];
	const store = this.store;
	for (const key in schema.attributes) if (schema.attributes.hasOwnProperty(key)) attrs.push(key);
	
	if (!store.insert_cache[tableName]) {
		store.insert_cache[tableName] = {
			rows: [],
			values: [],
			flush: function() {
				if (this.values.length) {
					let sql = 'insert into "'+tableName+'"';
					sql += ' (' + schema.attrStringLocal + ')';
					sql += ' values';
					sql += ' ' + this.rows.join(', ');
					
					const sets = [];
					for (const attr of attrs) sets.push('"'+attr+'" = excluded."'+attr+'"');
					sql += ' on conflict('+schema.pk_conflict+') do update set';
					sql += ' '+sets.join(', ');
					// console.log("> "+sql);
					store.execute(sql, this.values, { chunks: this.rows.length });
				}
				
				this.rows.length = 0;
				this.values = []; // still needed in the sql query
			}
		};
	}
	const insertCache = store.insert_cache[tableName];
	
	const exprs = [];
	const pushfn = sqlPushFunction(insertCache.values);
	for (const attr of attrs) {
		if (attr == schema.pk && this[attr] == null) {
			exprs.push("DEFAULT");
		} else {
			exprs.push(schema.attributes[attr].toSql(this[attr], pushfn));
		}
	}
	insertCache.rows.push('('+exprs.join(', ')+')');
	if (insertCache.values.length > 4096) insertCache.flush();
};

Model.defineModel = function(type, store, table, pk, attributes) {
	util.inherits(type, Model);
	type.prototype.store = store;
	type.prototype.schema = {
		pk: pk,
		pk_conflict: pk,
		tableName: table,
		attributes: attributes
	};
	
	const tblAttrs = [], tblAttrsLocal = [];
	for (let key in attributes) if (attributes.hasOwnProperty(key)) {
		tblAttrs.push('"'+table+'"."'+key+'"');
		tblAttrsLocal.push('"'+key+'"');
	}
	type.prototype.schema.attrString = tblAttrs.join(', ');
	type.prototype.schema.attrStringLocal = tblAttrsLocal.join(', ');
};

Model.Type = {};
Model.Type.Integer = {
	toSql: function(value, push) { let name = push(value); return name+"::integer"; },
	fromSql: function(value) { if (value == null) return null; return +value; },
	getDefault: function() { return null; }
};
Model.Type.BigInt = {
	toSql: function(value, push) { let name = push(value); return name+"::bigint"; },
	fromSql: function(value) { if (value == null) return null; return +value; },
	getDefault: function() { return null; }
};
Model.Type.Timestamp = {
	toSql: function(value, push) { let name = push(value); return name+"::timestamp"; },
	fromSql: function(value) { return value; }, // TODO
	getDefault: function() { return null; }
};
Model.Type.Text = {
	toSql: function(value, push) { let name = push(value); return name; },
	fromSql: function(value) { return value; },
	getDefault: function() { return null; }
};
Model.Type.Bool = {
	toSql: function(value, push) { let name = push(value); return name; },
	fromSql: function(value) { if (value == null) return null; return value?true:false; },
	getDefault: function() { return null; }
}
Model.Type.Position = {
	toSql: function(value, push) {
		let x = push(value.x), y = push(value.y), z = push(value.z);
		return "cube(array["+x+"::float, "+y+"::float, "+z+"::float])";
	},
	fromSql: function(value) {
		if (value == null) return null;
		const array = JSON.parse('[' + value.slice(1, value.length - 1) + ']');
		return { x: +array[0], y: +array[1], z: +array[2] };
	},
	getDefault: function() { return { x: null, y: null, z: null }; }
}
Model.Type.Cube = {
	toSql: function(value, push) {
		const lx = push(value.from.x), ly = push(value.from.y), lz = push(value.from.z);
		const hx = push(value.to.x  ), hy = push(value.to.y  ), hz = push(value.to.z  );
		return "cube(array["+lx+"::float, "+ly+"::float, "+lz+"::float], array["+hx+"::float, "+hy+"::float, "+hz+"::float])";
	},
	fromSql: function(value) {
		assert(false); // what are you even. TODO??
	},
	getDefault: function() { return {from: { x: null, y: null, z: null }, to: {x: null, y: null, z: null}}; }
}
