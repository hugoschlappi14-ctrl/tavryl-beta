extends SceneTree

var role: String
var folder: String
var net: Node
var player: CharacterBody2D
var social: Node
var started := 0
var authenticated := -1
var first_world := -1
var last_world := -1
var world_gaps: Array[int] = []
var last_write := 0
var last_id := 0
var target := ""
var spell_start := -1
var spell_hp := -1
var spell_result := -1
var spell_fired := false
var last_health: Array = []
var sent := ""
var got := ""
var stamp := -1
var route := Vector2.INF
var chase := ""
var endurance_defend := false
var initial := Vector2.ZERO
var offline_motion := 0.0
var server_version := ""
var remote_motion: Dictionary = {}
var track_started := -1
var track_frames: Array[int] = []
var track_last_frame := -1
var last_notice := ""
var max_frame_gap := 0
var last_frame := -1
var world_stalls: Array = []
var world_arrivals: Array = []
var life_events: Array = []
var last_life: Array = []
var last_world_at := -1
var portal_ms := -1
var lisiere_enter_ms := -1
var lisiere_world_ms := -1
var lisiere_map_ms := -1
var lisiere_map_prepared := false
var lisiere_frame_max_ms := 0
var lisiere_world_max_ms := 0

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	if not OS.get_user_data_dir().replace("\\","/").contains("/.test_"):
		quit(2)
		return
	var args := OS.get_cmdline_user_args()
	role = args[0]
	folder = args[1]
	net = root.get_node("ReseauAether")
	server_version = OS.get_environment("TAVRYL_TEST_VERIFIED_SERVER")
	net.monde_synchronise.connect(func():
		world_arrivals.append({"tick":Time.get_ticks_msec(), "unix_ms":int(Time.get_unix_time_from_system()*1000.0), "seq":net.derniere_sequence_monde}))
	social = root.get_node("SocialTavryl")
	net.authentification_reussie.connect(func(): authenticated = Time.get_ticks_msec())
	net.get_node("ConnexionAutomatique").wake.request_completed.connect(func(result, code, _headers, bytes):
		last_health.append([Time.get_ticks_msec() - started, result, code])
		if result == HTTPRequest.RESULT_SUCCESS and code == 200:
			var data: Variant = JSON.parse_string(bytes.get_string_from_utf8())
			if data is Dictionary and data.get("status") == "ready":
				server_version = str(data.get("version", "")))
	social.message_received.connect(func(message): got = str(message.text); stamp = Time.get_ticks_msec())
	social.notice.connect(func(message): last_notice = message)
	root.get_node("SessionJeu").choisir_personnage(1, "Test interne " + role.trim_prefix("Client"), true)
	change_scene_to_file("res://scenes/monde/principale.tscn")
	await scene_changed
	for n in range(15):
		await process_frame
	player = current_scene.get_node("Joueur")
	initial = player.global_position
	started = Time.get_ticks_msec()
	current_scene.get_node("Interface").selectionner_classe_par_index(int(role.trim_prefix("Client")))
	current_scene.get_node("GestionQuetes").accepter_quete("serment_du_chasseur")
	process_frame.connect(step)
	var endurance_minutes := clampi(int(OS.get_environment("TAVRYL_ENDURANCE_MINUTES")), 0, 30)
	create_timer(210 + endurance_minutes * 60).timeout.connect(func(): quit(2))

func step() -> void:
	var now := Time.get_ticks_msec()
	if not is_instance_valid(player) or current_scene == null:
		return
	var zone: String = net.obtenir_zone_position(player.global_position)
	var life := [zone,player.points_de_vie,player.a_terre,player.en_reapparition,player.point_reapparition]
	if life != last_life:
		life_events.append({"unix_ms":int(Time.get_unix_time_from_system()*1000.0),"zone":zone,
			"hp":player.points_de_vie,"down":player.a_terre,"respawning":player.en_reapparition,
			"checkpoint":[player.point_reapparition.x,player.point_reapparition.y]})
		last_life = life
	if zone == "lisiere" and lisiere_enter_ms < 0:
		lisiere_enter_ms = now
	if lisiere_enter_ms >= 0 and now - lisiere_enter_ms < 2200:
		if last_frame >= 0:
			lisiere_frame_max_ms = maxi(lisiere_frame_max_ms, now - last_frame)
		if lisiere_map_ms < 0:
			var presentation := current_scene.get_node_or_null("PresentationTavryl")
			if presentation != null and presentation.maps.has("lisiere"):
				lisiere_map_ms = int(presentation.maps["lisiere"].get_meta("load_ms", -1))
				lisiere_map_prepared = bool(presentation.maps["lisiere"].get_meta("prepared_before_entry", false))
	if last_frame >= 0: max_frame_gap = maxi(max_frame_gap, now - last_frame)
	last_frame = now
	if now - started < 1700:
		if not Input.is_action_pressed("deplacer_droite"): Input.action_press("deplacer_droite")
	elif not route.is_finite():
		Input.action_release("deplacer_droite")
	if authenticated < 0:
		offline_motion = maxf(offline_motion, initial.distance_to(player.global_position))
	if net.derniere_sequence_monde != last_world:
		if lisiere_enter_ms >= 0 and now - lisiere_enter_ms < 2200 and last_world_at >= 0:
			lisiere_world_max_ms = maxi(lisiere_world_max_ms, now - last_world_at)
		if zone == "lisiere" and lisiere_world_ms < 0 and not net.entites_reseau.is_empty():
			lisiere_world_ms = now
		if last_world_at >= 0 and now - last_world_at >= 180:
			world_stalls.append({"at":now - started, "unix_ms":int(Time.get_unix_time_from_system()*1000.0), "seq":net.derniere_sequence_monde, "gap":now - last_world_at,
				"frame":max_frame_gap, "sequence_gap":net.derniere_sequence_monde - last_world})
		last_world_at = now
		max_frame_gap = 0
		last_world = net.derniere_sequence_monde
		if first_world < 0: first_world = now
		world_gaps.append(now)
	if route.is_finite():
		var goal := route
		var chased: Node2D = net.entites_reseau.get(chase)
		if is_instance_valid(chased):
			goal = chased.global_position + chased.global_position.direction_to(player.global_position) * 68.0
		var offset := goal - player.global_position
		var direction := offset.normalized() if offset.length() > 12.0 else Vector2.ZERO
		if direction != Vector2.ZERO and player.test_move(player.global_transform, direction * 24.0):
			for angle: float in [PI / 4, -PI / 4, PI / 2, -PI / 2, PI * 0.75, -PI * 0.75]:
				var detour := direction.rotated(angle)
				if net.obtenir_zone_position(player.global_position + detour * 36.0) == net.obtenir_zone_position(player.global_position) and not player.test_move(player.global_transform, detour * 40.0):
					direction = detour
					break
		hold("deplacer_droite", direction.x > 0.25)
		hold("deplacer_gauche", direction.x < -0.25)
		hold("deplacer_bas", direction.y > 0.25)
		hold("deplacer_haut", direction.y < -0.25)
	if endurance_defend:
		var nearest: Node2D = null
		var best := 300.0
		for entity in net.entites_reseau.values():
			if not is_instance_valid(entity) or not entity is Node2D or entity.get("points_de_vie") == null or entity.points_de_vie <= 0: continue
			var d: float = entity.global_position.distance_to(player.global_position)
			if d < best:
				best=d; nearest=entity
		if nearest != null:
			var aim := InputEventMouseMotion.new()
			aim.position = nearest.get_global_transform_with_canvas().origin
			Input.parse_input_event(aim)
		hold("attaquer",nearest != null and not player.a_terre and not player.en_reapparition)
	if spell_start > 0 and spell_result < 0:
		var enemy: Node = net.entites_reseau.get(target)
		if is_instance_valid(enemy) and enemy.points_de_vie < spell_hp:
			spell_result = now - spell_start
	if track_started >= 0:
		if track_last_frame >= 0:
			track_frames.append(now - track_last_frame)
		track_last_frame = now
		for key in net.avatars_distants:
			var avatar: Node2D = net.avatars_distants[key]
			if not is_instance_valid(avatar) or not avatar.visible: continue
			var seq := int(avatar.get_meta("derniere_sequence", -1))
			if seq < 0: continue
			var peer := str(key)
			if not remote_motion.has(peer):
				remote_motion[peer] = {"last": -1, "packets": [], "positions": []}
			var samples: Dictionary = remote_motion[peer]
			if seq != samples.last:
				samples.last = seq
				samples.packets.append([now - track_started, seq, avatar.position_cible.x, avatar.position_cible.y])
			samples.positions.append([now - track_started, avatar.global_position.x, avatar.global_position.y])
	if now - last_write < 75: return
	last_write = now
	var command_path := folder.path_join(role + "-command.json")
	if FileAccess.file_exists(command_path):
		var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(command_path))
		if data is Dictionary and int(data.id) > last_id:
			last_id = int(data.id)
			command(data)
	var other := []
	for key in net.avatars_distants:
		var avatar: Node2D = net.avatars_distants[key]
		if is_instance_valid(avatar) and avatar.visible:
			other.append({"peer": int(key), "xy": [avatar.global_position.x, avatar.global_position.y], "target": [avatar.position_cible.x, avatar.position_cible.y], "seq": avatar.get_meta("derniere_sequence", -1)})
	var enemies := []
	for key in net.entites_reseau:
		var enemy: Node2D = net.entites_reseau[key]
		if is_instance_valid(enemy) and "points_de_vie" in enemy and enemy.visible and enemy.points_de_vie > 0:
			var xy := enemy.global_position
			enemies.append({"id": key, "xy": [xy.x,xy.y], "hp": enemy.points_de_vie, "name": enemy.nom_affiche})
	var report := {
		"id": last_id, "mode": net.mode, "social": social.state,
		"auth_ms": authenticated - started if authenticated >= 0 else -1,
		"world_ms": first_world - started if first_world >= 0 else -1,
		"health": last_health, "world_times": world_gaps,
		"world_stalls": world_stalls,
		"world_arrivals": world_arrivals,
		"life_events": life_events,
		"hp":player.points_de_vie,"down":player.a_terre,"respawning":player.en_reapparition,
		"checkpoint":[player.point_reapparition.x,player.point_reapparition.y],
		"portal": {"commandMs":portal_ms, "enterMs":lisiere_enter_ms, "firstWorldMs":lisiere_world_ms, "mapPrepared":lisiere_map_prepared,
			"mapLoadMs":lisiere_map_ms, "frameMaxMs":lisiere_frame_max_ms, "worldGapMaxMs":lisiere_world_max_ms,
			"enterUnixMs": int(Time.get_unix_time_from_system()*1000.0) - now + lisiere_enter_ms if lisiere_enter_ms >= 0 else null},
		"server_version": server_version, "peer": net.multiplayer.get_unique_id(), "notice": last_notice,
		"remote_motion": remote_motion, "track_frames": track_frames,
		"offline_motion": offline_motion, "position": [player.global_position.x,player.global_position.y],
		"zone": net.obtenir_zone_position(player.global_position), "safe": player.dans_zone_sure,
		"known_zone": net.zone_locale_connue, "sequence_local": net.sequence_locale,
		"other": other, "enemies": enemies,
		"avatar_debug": net.avatars_distants.values().map(func(a): return {"peer":a.identifiant_pair,"visible":a.visible,"zone":a.get_meta("zone_reseau", ""),"xy":[a.global_position.x,a.global_position.y],"seq":a.get_meta("derniere_sequence",-1)}),
		"roster_zones": net.informations_joueurs.keys().map(func(p): return {"peer":p,"zone":net.informations_joueurs[p].get("zone","")}),
		"stamp": stamp, "sent": sent, "got": got,
		"spell_start": spell_start, "spell_result": spell_result, "spell_fired": spell_fired,
	}
	var output := FileAccess.open(folder.path_join(role + "-state.json"),FileAccess.WRITE)
	output.store_string(JSON.stringify(report))

func hold(action: String, pressed: bool) -> void:
	if pressed and not Input.is_action_pressed(action):
		Input.action_press(action)
	elif not pressed and Input.is_action_pressed(action):
		Input.action_release(action)

func command(data: Dictionary) -> void:
	match str(data.action):
		"defend":
			endurance_defend=bool(data.get("enabled",true))
			if not endurance_defend: hold("attaquer",false)
		"reset_metrics":
			# Bound test-file IO during long sessions; never alter game state.
			world_gaps.clear(); world_arrivals.clear(); world_stalls.clear(); life_events.clear()
			remote_motion.clear(); track_frames.clear(); track_started = -1
		"halt":
			route = Vector2.INF; chase = ""
			for key in ["deplacer_droite","deplacer_gauche","deplacer_bas","deplacer_haut"]: Input.action_release(key)
		"respawn_test":
			# Isolated test profile only: exercise the ordinary death/respawn path.
			route=Vector2.INF; chase=""
			for key in ["deplacer_droite","deplacer_gauche","deplacer_bas","deplacer_haut"]: Input.action_release(key)
			player.invulnerable=false
			player.set_meta("degats_reseau_autorises",true)
			player.recevoir_degats(100000,player.global_position+Vector2(20,0))
			if player.a_terre: player.temps_a_terre_restant=0.05
		"social":
			social.act(str(data.kind), str(data.get("target","")), str(data.get("text","")))
			sent = str(data.get("text",""))
		"walk":
			route = Vector2(data.xy[0],data.xy[1])
			chase = str(data.get("chase",""))
		"travel":
			portal_ms = Time.get_ticks_msec()
			route = Vector2.INF
			chase = ""
			for key in ["deplacer_droite", "deplacer_gauche", "deplacer_bas", "deplacer_haut"]:
				Input.action_release(key)
			var world := current_scene
			if not world.has_method("_teleporter_vers"):
				world = current_scene.get_node("MondeVivant")
			for portal in world.TELEPORTS:
				if portal.position.distance_to(player.global_position) < 60.0:
					world._activer_ou_utiliser_teleport(portal)
					break
			for button in world.liste_teleports.get_children():
				for connection in button.pressed.get_connections():
					if connection.callable.get_bound_arguments() == [str(data.get("zone", "lisiere"))]:
						button.pressed.emit()
						return
		"cast":
			target = str(data.target)
			var enemy: Node = net.entites_reseau.get(target)
			if not is_instance_valid(enemy): return
			spell_hp = enemy.points_de_vie
			spell_result = -1
			spell_start = Time.get_ticks_msec()
			player._utiliser_competence(0)
			spell_fired = player.obtenir_recharge_competence(0) > 0.0
		"raise_counter":
			net.sequence_locale = int(data.counter)
		"track":
			remote_motion.clear()
			track_frames.clear()
			track_started = Time.get_ticks_msec()
			track_last_frame = -1
		"stop_track":
			track_started = -1
		"stop":
			process_frame.disconnect(step)
			net.deconnecter(false)
			await process_frame
			quit()
