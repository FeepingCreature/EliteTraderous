const NumberBag = module.exports.NumberBag = function(numbers) {
	this.array = new Uint32Array(numbers.length);
	numbers.sort(function(a, b) { return a - b; });
	let i = 0;
	for (const num of numbers) {
		this.array[i++] = num;
	}
	this.length = i;
};

NumberBag.prototype.contains = function(number) {
	let low = 0, high = this.array.length;
	while (low != high) {
		let pivot = low + Math.floor((high - low) / 2);
		if (this.array[pivot] == number) return true;
		else if (this.array[pivot] > number) high = pivot;
		else low = pivot + 1;
	}
	return false;
};

NumberBag.prototype.values = function() {
	const self = this;
	return {
		index: 0,
		[Symbol.iterator]() {
			return this;
		},
		next() {
			if (this.index < self.array.length) return {value: self.array[this.index++], done: false};
			return {done: true};
		}
	};
};
