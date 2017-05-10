const util = require('util');
const ProgressBar = require('progress');
const config = require(__base+'/config.json');

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
		if (config.db_type == 'sqlite') return "?"+values_array.length;
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
	if (attrs == null) return;
	const attributes = this.schema.attributes;
	const dup = Object.assign({}, attrs);
	let str = JSON.stringify(attrs);
	for (var key in attributes) if (attributes.hasOwnProperty(key)) {
		attributes[key].setFromSqlDestructive(key, this, attrs);
	}
	for (var key in attrs) if (attrs.hasOwnProperty(key)) {
		throw new Error("Cannot set "+key+": attribute not in model! - "+Object.keys(attributes).join(","));
	}
	// console.log("set from "+str+": "+JSON.stringify(this));
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
		+'where '+((config.db_type == 'sqlite')?'1':'true')+' '; // makes "and where" easier
	for (const key in conditions) if (conditions.hasOwnProperty(key)) {
		const value = conditions[key];
		if (value && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
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
					let sql = '';
					if (config.db_type == 'sqlite') {
						sql += 'replace into "'+tableName+'"';
					} else {
						sql += 'insert into "'+tableName+'"';
					}
					sql += ' (' + schema.attrStringInsert + ')';
					sql += ' values';
					sql += ' ' + this.rows.join(', ');
					
					if (config.db_type == 'postgresql') {
						const sets = [];
						for (const attr of attrs) sets.push('"'+attr+'" = excluded."'+attr+'"');
						sql += ' on conflict('+schema.pk_conflict+') do update set';
						sql += ' '+sets.join(', ');
					}
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
			if (schema.options.hack_skip_pk_on_save) {
			} else {
				exprs.push(schema.attributes[attr].deflt_sql?schema.attributes[attr].deflt_sql:"DEFAULT");
			}
		} else {
			var attr_exprs = schema.attributes[attr].toSql(this[attr], pushfn);
			if (Array.isArray(attr_exprs)) for (const expr of attr_exprs) exprs.push(expr);
			else exprs.push(attr_exprs);
		}
	}
	insertCache.rows.push('('+exprs.join(', ')+')');
	const limit = (config.db_type == 'postgresql')?4096:512;
	if (insertCache.values.length > limit) insertCache.flush();
};

Model.defineModel = function(type, store, table, pk, attributes, options) {
	util.inherits(type, Model);
	type.prototype.store = store;
	
	if (!options) options = {};
	
	let pk_conflict = pk;
	if (typeof options.pk_conflict !== 'undefined') pk_conflict = options.pk_conflict;
	
	
	type.prototype.schema = {
		pk: pk,
		pk_conflict: pk_conflict,
		tableName: table,
		attributes: attributes,
		options: options
	};
	
	const tblAttrs = [], tblAttrsInsert = [];
	for (let key in attributes) if (attributes.hasOwnProperty(key)) {
		let subkeys = [key];
		if (attributes[key].getSubkeys) subkeys = attributes[key].getSubkeys(key);
		for (const subkey of subkeys) {
			tblAttrs.push('"'+table+'"."'+subkey+'"');
			if (options.hack_skip_pk_on_save && subkey == pk) continue;
			tblAttrsInsert.push('"'+subkey+'"');
		}
	}
	type.prototype.schema.attrString = tblAttrs.join(', ');
	type.prototype.schema.attrStringInsert = tblAttrsInsert.join(', ');
};

function defaultFromSqlDestructiveNumber(key, object, attrs) {
	if (typeof attrs[key] !== 'undefined') {
		if (attrs[key] == null) object[key] = null;
		else object[key] = +attrs[key];
		delete attrs[key];
	}
}

function defaultFromSqlDestructiveAny(key, object, attrs) {
	if (typeof attrs[key] !== 'undefined') {
		if (attrs[key] == null) object[key] = null;
		else object[key] = attrs[key];
		delete attrs[key];
	}
}

Model.Type = {};
Model.Type.Integer = {
	toSql: function(value, push) {
		if (value == null) return "NULL";
		let name = push(value);
		if (config.db_type == 'sqlite') return name;
		return name+"::integer";
	},
	setFromSqlDestructive: defaultFromSqlDestructiveNumber,
	getDefault: function() { return null; }
};
Model.Type.BigInt = {
	toSql: function(value, push) {
		if (value == null) return "NULL";
		let name = push(value);
		return name/*+"::bigint"*/;
	},
	setFromSqlDestructive: defaultFromSqlDestructiveNumber,
	getDefault: function() { return null; }
};
Model.Type.Float = {
	toSql: function(value, push) { let name = push(value); return name/*+"::float"*/; },
	setFromSqlDestructive: defaultFromSqlDestructiveNumber,
	getDefault: function() { return null; }
};
Model.Type.Timestamp = {
	toSql: function(value, push) {
		if (value == null) return "NULL";
		if (value instanceof SqlExpression) {
			return value.sql;
		}
		let name = push(value);
		return name+"::timestamp";
	},
	setFromSqlDestructive: defaultFromSqlDestructiveAny, // TODO
	getDefault: function() { return null; }
};
Model.Type.Text = {
	toSql: function(value, push) { let name = push(value); return name; },
	setFromSqlDestructive: defaultFromSqlDestructiveAny,
	getDefault: function() { return null; }
};
Model.Type.Bool = {
	toSql: function(value, push) { let name = push(value); return name; },
	setFromSqlDestructive: function(key, object, attrs) {
		if (typeof attrs[key] !== 'undefined') {
			if (attrs[key] == null) object[key] = null;
			else object[key] = attrs[key]?true:false;
			delete attrs[key];
		}
	},
	getDefault: function() { return null; }
};
Model.Type.Position = {
	toSql: function(value, push) {
		if (value.x == null) throw new Error("huh?");
		let x = push(value.x), y = push(value.y), z = push(value.z);
		if (config.db_type == 'postgresql') {
			return "cube(array["+x+"::float, "+y+"::float, "+z+"::float])";
		} else {
			return [x, y, z];
		}
	},
	setFromSqlDestructive: function(key, object, attrs) {
		if (config.db_type == 'postgresql') {
			if (typeof attrs[key] !== 'undefined') {
				if (attrs[key] == null) object[key] = { x: null, y: null, z: null };
				else {
					const value = attrs[key];
					const array = JSON.parse('[' + value.slice(1, value.length - 1) + ']');
					object[key] = { x: +array[0], y: +array[1], z: +array[2] };
				}
				delete attrs[key];
			}
		} else {
			defaultFromSqlDestructiveNumber(key+'_x', object, attrs);
			defaultFromSqlDestructiveNumber(key+'_y', object, attrs);
			defaultFromSqlDestructiveNumber(key+'_z', object, attrs);
			object[key] = { x: object[key+'_x'], y: object[key+'_y'], z: object[key+'_z'] };
			delete object[key+'_x'];
			delete object[key+'_y'];
			delete object[key+'_z'];
			delete attrs[key];
		}
	},
	sqlCubeDistanceSmaller: function(attr, pos, range, push) {
		const Float = Model.Type.Float;
		if (config.db_type == 'postgresql') {
			return 'cube_distance('+this.toSql(pos, push)+', '+attr+') < '+push(range);
		}
		const x_dist = '('+Float.toSql(pos.x, push)+' - '+attr+'_x)';
		const y_dist = '('+Float.toSql(pos.y, push)+' - '+attr+'_y)';
		const z_dist = '('+Float.toSql(pos.z, push)+' - '+attr+'_z)';
		return x_dist+'*'+x_dist+' + '+y_dist+'*'+y_dist+' + '+z_dist+'*'+z_dist+' < '+push(range*range);
	},
	getSubkeys: function(key) {
		if (config.db_type == 'postgresql') return [key];
		else return [key+'_x', key+'_y', key+'_z'];
	},
	getDefault: function() { return { x: null, y: null, z: null }; }
};
if (config.db_type != 'postgresql') Model.Type.Position.deflt_sql = 'DEFAULT, DEFAULT, DEFAULT';
Model.Type.Cube = {
	toSql: function(value, push) {
		const lx = push(value.from.x), ly = push(value.from.y), lz = push(value.from.z);
		const hx = push(value.to.x  ), hy = push(value.to.y  ), hz = push(value.to.z  );
		return "cube(array["+lx+"::float, "+ly+"::float, "+lz+"::float], array["+hx+"::float, "+hy+"::float, "+hz+"::float])";
	},
	sqlAttrInCube: function(attr, cube, push) {
		if (config.db_type == 'postgresql') {
			return attr+' <@ '+this.toSql(cube, push);
		}
		const Float = Model.Type.Float;
		return '('+
			attr+'_x >= '+Float.toSql(cube.from.x, push)+' and '+
			attr+'_y >= '+Float.toSql(cube.from.y, push)+' and '+
			attr+'_z >= '+Float.toSql(cube.from.z, push)+' and '+
			attr+'_x <= '+Float.toSql(cube.to.x, push)+' and '+
			attr+'_y <= '+Float.toSql(cube.to.y, push)+' and '+
			attr+'_z <= '+Float.toSql(cube.to.z, push)+
		')';
	},
	setFromSqlDestructive: function(key, object, attrs) {
		assert(false); // what are you even. TODO??
	},
	getDefault: function() { return {from: { x: null, y: null, z: null }, to: {x: null, y: null, z: null}}; }
}
