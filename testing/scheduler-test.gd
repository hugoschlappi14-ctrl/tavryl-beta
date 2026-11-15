extends SceneTree

const Measure = preload("res://mesure_ordonnancement.gd")

func _initialize() -> void:
	assert(Measure.analyser("").is_empty())
	assert(Measure.analyser("bad counters here").is_empty())
	assert(Measure.analyser("1000000 2000000 3") == PackedInt64Array([1000000, 2000000]))
	assert(Measure.ecart_ms(PackedInt64Array(), PackedInt64Array(), 0) == -1.0)
	var before := Measure.lire()
	assert(before.size() == 2, "Linux scheduler counters must be readable")
	var start := Time.get_ticks_usec()
	while Time.get_ticks_usec() - start < 150000:
		pass
	var busy := Measure.lire()
	OS.delay_msec(150)
	var slept := Measure.lire()
	var busy_cpu := Measure.ecart_ms(before, busy, 0)
	var sleep_cpu := Measure.ecart_ms(busy, slept, 0)
	assert(busy_cpu > 0.0, "CPU work must increase the runtime counter")
	assert(sleep_cpu < busy_cpu, "Sleep must not be mistaken for CPU work")
	assert(Measure.ecart_ms(before, slept, 1) >= 0.0)
	print("TAVRYL_SCHEDULER_TEST busy_cpu_ms=", busy_cpu, " sleep_cpu_ms=", sleep_cpu,
		" scheduler_wait_ms=", Measure.ecart_ms(before, slept, 1))
	quit()
