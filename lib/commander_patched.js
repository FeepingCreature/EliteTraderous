const commander = require('commander');
const util = require('util');

function camelcase(flag) {
  return flag.split('-').reduce(function(str, word) {
    return str + word[0].toUpperCase() + word.slice(1);
  });
}

function PatchedCommand(name) {
	commander.Command.call(this, name);
	this.required = {}; // lets us print more than one error during processing
	this.optionRequired = function(flags, description, fn, defaultValue) {
		this.option(flags, description, fn, defaultValue);
		let option = this.options[this.options.length - 1];
		let oname = option.name();
		let name = camelcase(oname);
		this.required[name] = oname;
		
		return this;
	};
	this.errorWithStyle = function(printMsg) {
		console.error();
		if (typeof printMsg === 'function') printMsg();
		else console.error("  error: "+printMsg);
		console.error();
		process.exit(1);
	};
	this.errorRequiredOptionMissing = function(opt) {
		console.error("  error: required option `%s' missing", opt);
	};
	this.parse = function(argv) {
		const result = commander.Command.prototype.parse.call(this, argv);
		let errored = false;
		for (const key in this.required) if (this.required.hasOwnProperty(key)) {
			if (!result.hasOwnProperty(key)) {
				if (!errored) {
					console.error();
					errored = true;
				}
				this.errorRequiredOptionMissing(this.required[key]);
			}
		}
		if (errored) {
			console.error();
			process.exit(1);
		}
		return result;
	};
}
util.inherits(PatchedCommand, commander.Command);

exports = module.exports = new PatchedCommand();
exports.Command = PatchedCommand;
exports.Option = commander.Option;
