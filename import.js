global.__base = __dirname + '/';
const fs = require('fs');
const session = require(__base+'/lib/session.js');
const config = require(__base+'/config.json');
const store = require(__base+'/lib/store.js');

require('co')(function*() {
	const session_obj = new session.Session();
	
	const db_store = new store.Store();
	yield* db_store.connect();
	
	const profile = yield* session_obj.load_profile();
	yield* db_store.Trade.import_profile(profile);
	
	// fs.writeFileSync("profile.json", JSON.stringify(profile, null, 2));
	
	process.exit(0);
}).catch(function(err) {
  console.error(err.stack);
  process.exit(1);
});
