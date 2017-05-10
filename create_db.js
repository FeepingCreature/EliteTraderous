global.__base = __dirname + '/';
const co = require('co');

const store = require(__base+'/lib/store.js');

co(function*() {
	const db_store = new store.Store();
	
	yield* db_store.connect();
	yield* db_store.create_tables();
	
	console.log("Done.");
	
	process.exit(0);
}).catch(function(err) {
  console.error(err.stack);
  process.exit(1);
});
