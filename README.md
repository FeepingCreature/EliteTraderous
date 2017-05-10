# EliteTraderous

Trade Route Calculator for Elite Dangerous, in the style of TradeDangerous, but stochastic.

Instead of exhaustively searching all possible routes, as TradeDangerous does, EliteTraderous creates trade routes at random,
then keeps the best ones. This allows it to return acceptable results more quickly, but the route you get may not be the best one.

Written in Node.js; requires a PostgreSQL server for system and trade data.

## Installation

1. Install Node.js and make sure you have it in your path by opening a command line (`cmd.exe`), then running `node -v`
2. Install the required packages by running `npm install` in the EliteTraderous folder
3. **Optionally**, install PostgreSQL and create a database for the program
   * Configure your database's settings in `config.json`
   * See the bottom of this page for an example configuration
   * By default, we'll create a Sqlite database, which runs a little slower (but not much)
4. Initialize the program's tables by running `node create_db.js`
5. Import the current system and market data from eddb.io
   * Run `node fetch.js` in folder eddb to download the eddb.io dumps
   * Import the dumps by running `node import_eddb.js`

You should be good to go!

## Usage

You can import station data when docked by running `node import.js`. The first time you do this, the tool will
ask for your email and password. This information is only used to authenticate with Frontier's mobile API. The password is
not saved; session data is stored locally in the file `session.json`. Login is handled in `lib/session.js` in case you want
to confirm for yourself.

Call the trade router with `node trade.js`. It will search for trade routes and print the best ones it finds. Interrupt the search
with Control+C when you're bored of waiting.

The following flags are supported:

* -h, --help : print a help text
* --ly-per <n> : specify how many ly per jump your ship is capable of when fully loaded (`lyPer` in config.json)
* --cap <n> : how much cargo capacity your ship has available
* --from <text> : Specify the starting location. Format is "System/Station"; partial match is supported.
For instance, "HIP 13569/Jones' Pride" can be shortened to "13569/Jones".
* --to <text> : Specify the target location. Routes that don't reach the target are discarded.
* --loop : "to" is set to "from", causing all routes to return to the current station. Useful with --import.
* --pad-size <text> : When "L", only allows stations with large landing pads. When "M", only allows stations with at least medium landing pads. (`padSize` in config.json)
* --jumps-per <n> : How many jumps to permit between stations
* --hops <n> : Number of hops (from station to station) a trade route must consist of
* --max-hops : Trade route may be *at most* this long
* --import : Automatically update trade data at the start. This also defaults `--from` to the current docked station.`
* --no-planets : Don't consider landing on planetary stations. (`"planets": false` in config.json)
* --run-for <n> : Normally, EliteTraderous searches until you hit Control+C. With this flag, it will run for `n` seconds and then print the best route found so far.`
* --exclude <text> : Exclude a good from trading. Useful for forbidden goods. Can be specified multiple times; must be exact.

# Example configuration for Sqlite

    	"db_type": "sqlite",
    	"db": "data.sqlite",

# Example configuration for PostgreSQL

    	"db_type": "postgresql",
    	"db": {
    		"user": "postgres",
    		"database": "elitetraderous",
    		"host": "localhost",
    		"port": 5432
    	},


Fly safe, commander!
