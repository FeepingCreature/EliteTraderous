module.exports.between = function between(text, from, to) {
	var pos1 = (from == "") ? 0 : text.indexOf(from);
	if (pos1 == -1) return null;
	text = text.slice(pos1 + from.length, text.length);
	
	var pos2 = (to == "") ? text.length : text.indexOf(to);
	if (pos2 == -1) return null;
	text = text.slice(0, pos2);
	
	return text;
};
