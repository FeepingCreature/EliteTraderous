global.__base = __dirname + '/';
const pg = require('pg');
const co = require('co');

const config = require(__base+'/config.json');
const store = require(__base+'/lib/store.js');
const pool = new pg.Pool(config.db);

co(function*() {
	const client = yield pool.connect();
	const db_store = new store.Store(client);
	
	yield* db_store.create_tables();
	
	console.log("Done.");
	
	process.exit(0);
}).catch(function(err) {
  console.error(err.stack);
  process.exit(1);
});
