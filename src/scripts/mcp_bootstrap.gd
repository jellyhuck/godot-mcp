extends SceneTree

# MCP bootstrap - launched by run_project as
#   godot --path <project> --script <build>/scripts/mcp_bootstrap.gd
# It adds the MCP interaction server to the scene tree and then starts the
# project's main scene (or the scene named by GODOT_MCP_SCENE). Running this
# way means nothing is ever written into the project directory: no autoload
# entry in project.godot and no copied script, so there is nothing to clean up.

const AUTOLOAD_NAME: String = "McpInteractionServer"
const SERVER_SCRIPT: String = "mcp_interaction_server.gd"
const SCENE_ENV_VAR: String = "GODOT_MCP_SCENE"


func _initialize() -> void:
	_add_interaction_server()

	var requested: String = OS.get_environment(SCENE_ENV_VAR).strip_edges()
	if requested.is_empty() and current_scene != null:
		# The engine already loaded a scene; leave it alone.
		return

	var scene_path: String = _resolve_scene(requested)
	if scene_path.is_empty():
		push_error("McpBootstrap: No scene to run. Set application/run/main_scene or pass a scene to run_project.")
		quit(1)
		return

	var err: int = change_scene_to_file(scene_path)
	if err != OK:
		push_error("McpBootstrap: Failed to load scene '%s' (error %d)" % [scene_path, err])
		quit(1)
		return
	print("McpBootstrap: Starting scene %s" % scene_path)


func _add_interaction_server() -> void:
	if ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME):
		print("McpBootstrap: Project registers %s itself; not adding a second one" % AUTOLOAD_NAME)
		return

	var own_script: Script = get_script() as Script
	var script_path: String = own_script.resource_path.get_base_dir().path_join(SERVER_SCRIPT)
	var server_script: Script = load(script_path) as Script
	if server_script == null:
		push_error("McpBootstrap: Could not load interaction server script at %s" % script_path)
		return

	var server: Node = server_script.new() as Node
	if server == null:
		push_error("McpBootstrap: Interaction server script did not produce a Node")
		return
	server.name = AUTOLOAD_NAME
	root.add_child(server)
	print("McpBootstrap: Added %s to the scene tree" % AUTOLOAD_NAME)


func _resolve_scene(requested: String) -> String:
	var scene_path: String = requested
	if scene_path.is_empty():
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene_path.is_empty():
		return ""
	if not scene_path.begins_with("res://") and not scene_path.begins_with("uid://") and not scene_path.is_absolute_path():
		scene_path = "res://" + scene_path
	return scene_path
