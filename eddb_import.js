global.__base = __dirname + '/';
const co = require('co');
const fs = require('fs');
const csv = require('csv-parser');
const StreamFromIterator = require('stream-from-iterator');
const config = require(__base+'/config.json');
const store = require(__base+'/lib/store.js');

const eddb_fixups = {
	"Animalmeat": "Animal Meat",
	"CMM Composite": "C M M Composite",
	"Fruit And Vegetables": "Fruit and Vegetables",
	"Hazardous Environment Suits": "H.E. Suits",
	"Low Temperature Diamond": "Low Temperature Diamonds",
	"Non Lethal Weapons": "Non-lethal Weapons",
	"Skimer Components": "Skimmer Components"
};

co(function*() {
	const db_store = new store.Store();
	yield* db_store.connect();
	
	console.log("Inserting systems.");
	const systems = require(__base+'/eddb/systems_populated.json');
	const duplicate_name_check = {};
	const system_names = {};
	yield new Promise(function(resolve, reject) {
		let systems_iterator = new StreamFromIterator(systems.entries(), {objectMode: true});
		db_store.expected_records = systems.length;
		
		systems_iterator.pipe(new db_store.FlushStream(function(pair) {
			const [index, system]  = pair;
			system_names[system.id] = system.name;
			
			let attrs = {
				id: system.id,
				name: system.name,
				needs_permit: system.needs_permit
			};
			if (config.db_type == 'postgresql') {
				attrs.position = '('+system.x+', '+system.y+', '+system.z+')';
			} else {
				attrs.position_x = system.x;
				attrs.position_y = system.y;
				attrs.position_z = system.z;
			}
			let db_system = new db_store.System(attrs);
			db_system.save();
		})).on('finish', resolve).on('error', reject);
	});
	
	console.log("Inserting stations.");
	const stations = require(__base+'/eddb/stations.json');
	const station_names = {};
	yield new Promise(function(resolve, reject) {
		let stations_iterator = new StreamFromIterator(stations.entries(), {objectMode: true});
		db_store.expected_records = stations.length;
		stations_iterator.pipe(new db_store.FlushStream(function(pair) {
			const [index, station] = pair;
			
			if (!system_names[station.system_id]) {
				console.log("missing system id "+station.system_id);
				return;
			}
			
			station_names[station.id] = station.name;
			
			let combine_name = system_names[station.system_id] + "/" + station.name;
			if (duplicate_name_check[combine_name]) {
				console.log("duplicate system/station name "+combine_name);
				return;
			}
			duplicate_name_check[combine_name] = true;
			
			let db_station = new db_store.Station({
				id: station.id,
				system_id: station.system_id,
				name: station.name,
				max_landing_pad_size: station.max_landing_pad_size,
				distance_to_star: station.distance_to_star,
				has_market: station.has_market,
				is_planetary: station.is_planetary,
			});
			db_station.save();
		})).on('finish', resolve).on('error', reject);
	});
	
	let commodities_file = require(__base+'/eddb/commodities.json');
	let commodity_names = [];
	for (var commodity of commodities_file) {
		let name = commodity.name;
		if (name in eddb_fixups) name = eddb_fixups[name];
		commodity_names[+commodity.id] = name;
	}
	
	console.log("Inserting listings.");
	yield new Promise(function(resolve, reject) {
		db_store.expected_records = 3000000; // estimate
		let index = 0;
		let dupecheck = {};
		let csv_parser = fs.createReadStream(__base+'/eddb/listings.csv')
		.pipe(csv())
		.pipe(new db_store.FlushStream(function(record) {
			// if (index % 10000 == 0) console.log("> "+index+" "+JSON.stringify(record));
			
			if (!station_names[+record.station_id]) {
				console.log("Invalid record: station "+record.station_id+" not known!");
				return;
			}
			
			let trade = new db_store.Trade({
				station_id: +record.station_id,
				id: +record.id,
				name: commodity_names[+record.commodity_id],
				buyPrice: +record.buy_price,
				sellPrice: +record.sell_price,
				stock: +record.supply
			});
			trade.save();
			// TODO update station collected_at
			index++;
		})).on('finish', resolve).on('error', reject);
	});

	console.log("Done.");
	
	process.exit(0);
}).catch(function(err) {
  console.error(err.stack);
  process.exit(1);
});
