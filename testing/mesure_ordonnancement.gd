extends RefCounted
## Numeric Linux scheduler counters only; no identity, packet or credential data.
static func lire() -> PackedInt64Array:
	if OS.get_name() != "Linux": return PackedInt64Array()
	var fichier := FileAccess.open("/proc/self/schedstat", FileAccess.READ)
	if fichier == null: return PackedInt64Array()
	return analyser(fichier.get_line())

static func analyser(ligne: String) -> PackedInt64Array:
	var champs := ligne.strip_edges().split(" ", false)
	if champs.size() < 3 or not champs[0].is_valid_int() or not champs[1].is_valid_int():
		return PackedInt64Array()
	return PackedInt64Array([int(champs[0]), int(champs[1])])

static func ecart_ms(avant: PackedInt64Array, apres: PackedInt64Array, index: int) -> float:
	if avant.size() != 2 or apres.size() != 2: return -1.0
	return snappedf(float(apres[index] - avant[index]) / 1000000.0, 0.001)
