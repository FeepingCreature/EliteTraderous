global.__base = __dirname + '/';
const pg = require('pg');
const fs = require('fs');
const session = require(__base+'/lib/session.js');
const config = require(__base+'/config.json');
const store = require(__base+'/lib/store.js');
const pool = new pg.Pool(config.db);

require('co')(function*() {
	const session_obj = new session.Session();
	const client = yield pool.connect();
	const db_store = new store.Store(client);
	
	const profile = yield* session_obj.load_profile();
	yield* db_store.Trade.import_profile(profile);
	
	// fs.writeFileSync("profile.json", JSON.stringify(profile, null, 2));
	
	process.exit(0);
}).catch(function(err) {
  console.error(err.stack);
  process.exit(1);
});
