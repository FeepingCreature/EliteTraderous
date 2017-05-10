const request = require('request');
const fs = require('fs');

function download(url, file) {
	request(url).pipe(fs.createWriteStream(file+'.new'))
	.on('finish', function() {
		console.log(file+" complete.");
		fs.renameSync(file+'.new', file);
	});
}

console.log("Downloading eddb.io datafiles.");
download('https://eddb.io/archive/v5/systems_populated.json', 'systems_populated.json');
download('https://eddb.io/archive/v5/stations.json', 'stations.json');
download('https://eddb.io/archive/v5/listings.csv', 'listings.csv');
download('https://eddb.io/archive/v5/commodities.json', 'commodities.json');
