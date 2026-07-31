--!nonstrict
--[[
	Bloxwright — Studio bridge plugin.

	Nothing can dial into Studio from outside, so this polls the Bloxwright desktop
	app on localhost instead: every tick it sends a small snapshot of the open
	place (so the assistant knows what you're actually working on) and collects
	any scripts you asked it to insert.

	Install: drop this file in your Studio Plugins folder
	(Plugins tab -> Plugins Folder), then click the Bloxwright button.
]]

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")
local InsertService = game:GetService("InsertService")
local MarketplaceService = game:GetService("MarketplaceService")

-- Bumped whenever the job protocol changes, so the app can tell the user that
-- Studio is still running an older copy of this file.
local PLUGIN_VERSION = 3

local BASE_URL = "http://127.0.0.1:8095"
-- Idle cadence. Low enough that the app notices Studio quickly, high enough
-- that it costs nothing to leave running all day.
local POLL_SECONDS = 3
-- While the app is actively building, every job would otherwise wait a full
-- idle poll — turning a fifty-object game into three minutes of pure waiting.
-- So once work starts arriving, poll hard until the queue drains.
local BUSY_POLL_SECONDS = 0.2

local toolbar = plugin:CreateToolbar("Bloxwright")
local button = toolbar:CreateButton(
	"Bloxwright",
	"Connect this place to the Bloxwright desktop app",
	"rbxasset://textures/ui/common/robux.png"
)
button.ClickableWhenViewportHidden = true

local connected = false
local loopToken = 0

-- Containers a generated script might reasonably be placed in. Anything not on
-- this list is rejected rather than guessed at — silently dropping a script
-- into the wrong service is worse than saying "I don't know where that goes".
local ROOTS = {
	Workspace = true,
	ServerScriptService = true,
	ServerStorage = true,
	ReplicatedStorage = true,
	ReplicatedFirst = true,
	StarterGui = true,
	StarterPack = true,
	StarterPlayer = true,
	Lighting = true,
	SoundService = true,
	Players = true,
	TestService = true,
	Teams = true,
}

local function log(message)
	print("[Bloxwright] " .. message)
end

local function splitPath(path: string): { string }
	local parts = {}
	for piece in string.gmatch(path, "[^%./\\]+") do
		if piece ~= "" then
			table.insert(parts, piece)
		end
	end
	return parts
end

local function instancePath(instance: Instance): string
	local parts = {}
	local node: Instance? = instance
	while node and node ~= game do
		table.insert(parts, 1, node.Name)
		node = node.Parent
	end
	return table.concat(parts, "/")
end

--[[
	Turn "ServerScriptService/Systems/Combat" into (parentInstance, "Combat"),
	creating intermediate Folders as needed. "selection" targets whatever is
	selected in the Explorer.
]]
local function resolveTarget(path: string): (Instance?, string?, string?)
	local parts = splitPath(path)
	if #parts == 0 then
		return nil, nil, "empty path"
	end

	local root: Instance
	if string.lower(parts[1]) == "selection" then
		local selected = Selection:Get()
		if #selected == 0 then
			return nil, nil, "nothing is selected in Studio"
		end
		root = selected[1]
		table.remove(parts, 1)
		if #parts == 0 then
			-- "path=selection" with no name: let the caller name it.
			return root, "BloxwrightScript", nil
		end
	else
		local rootName = parts[1]
		if not ROOTS[rootName] then
			return nil, nil, string.format("'%s' is not a place container I can write to", rootName)
		end
		local ok, service = pcall(function()
			return game:GetService(rootName)
		end)
		if not ok or not service then
			return nil, nil, string.format("could not get service '%s'", rootName)
		end
		root = service
		table.remove(parts, 1)
		if #parts == 0 then
			return nil, nil, "path needs a script name, not just a container"
		end
	end

	local scriptName = table.remove(parts, #parts)
	local parent = root
	for _, segment in ipairs(parts) do
		local child = parent:FindFirstChild(segment)
		if not child then
			child = Instance.new("Folder")
			child.Name = segment
			child.Parent = parent
		end
		parent = child
	end

	return parent, scriptName, nil
end

local SCRIPT_CLASSES = { Script = true, LocalScript = true, ModuleScript = true }

--[[
	Decode a property value sent as JSON. Roblox datatypes can't survive JSON on
	their own, so the app sends them as tagged tables ({ ["$t"] = "Vector3" }).
	Anything untagged is a plain string/number/boolean and passes through.
]]
local function decodeValue(value)
	if typeof(value) ~= "table" then
		return value
	end

	local tag = value["$t"]
	if tag == "Vector3" then
		return Vector3.new(value.x or 0, value.y or 0, value.z or 0)
	elseif tag == "Vector2" then
		return Vector2.new(value.x or 0, value.y or 0)
	elseif tag == "Color3" then
		return Color3.new(value.r or 0, value.g or 0, value.b or 0)
	elseif tag == "BrickColor" then
		return BrickColor.new(value.name or "Medium stone grey")
	elseif tag == "CFrame" then
		if value.lookAt then
			return CFrame.lookAt(
				Vector3.new(value.x or 0, value.y or 0, value.z or 0),
				Vector3.new(value.lookAt.x or 0, value.lookAt.y or 0, value.lookAt.z or 0)
			)
		end
		return CFrame.new(value.x or 0, value.y or 0, value.z or 0)
	elseif tag == "UDim" then
		return UDim.new(value.scale or 0, value.offset or 0)
	elseif tag == "UDim2" then
		return UDim2.new(value.xs or 0, value.xo or 0, value.ys or 0, value.yo or 0)
	elseif tag == "NumberRange" then
		return NumberRange.new(value.min or 0, value.max or value.min or 0)
	elseif tag == "Enum" then
		local enumType = Enum[value.enum]
		if enumType then
			local ok, item = pcall(function()
				return enumType[value.value]
			end)
			if ok then
				return item
			end
		end
		return nil
	end
	return nil
end

--[[
	Apply properties one at a time. A single bad property (wrong type, read-only,
	doesn't exist on this class) shouldn't throw away the other twelve — so each
	is attempted separately and the failures are reported back for the model to
	correct.
]]
local function applyProperties(instance: Instance, properties): { string }
	local failures = {}
	if typeof(properties) ~= "table" then
		return failures
	end
	for key, rawValue in pairs(properties) do
		local value = decodeValue(rawValue)
		if value == nil and typeof(rawValue) == "table" then
			table.insert(failures, string.format("%s (unsupported value)", key))
		else
			local ok, err = pcall(function()
				(instance :: any)[key] = value
			end)
			if not ok then
				table.insert(failures, string.format("%s (%s)", key, tostring(err)))
			end
		end
	end
	return failures
end

local function applyJob(job): (boolean, string)
	local className = job.type
	if not SCRIPT_CLASSES[className] then
		className = "Script"
	end

	local parent, scriptName, err = resolveTarget(job.path or "")
	if not parent or not scriptName then
		return false, err or "could not resolve that path"
	end

	local recording = ChangeHistoryService:TryBeginRecording("Bloxwright: " .. scriptName)

	local existing = parent:FindFirstChild(scriptName)
	local target: Instance
	local verb: string

	if existing and SCRIPT_CLASSES[existing.ClassName] then
		if existing.ClassName ~= className then
			-- Class can't be changed in place, and quietly leaving a LocalScript
			-- where a Script belongs would just not run. Replace it.
			local replacement = Instance.new(className)
			replacement.Name = scriptName
			replacement.Parent = parent
			existing:Destroy()
			target = replacement
			verb = "replaced"
		else
			target = existing
			verb = "updated"
		end
	else
		local created = Instance.new(className)
		created.Name = scriptName
		created.Parent = parent
		target = created
		verb = "created"
	end

	local ok, setErr = pcall(function()
		target.Source = job.source or ""
	end)

	if recording then
		if ok then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		else
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
		end
	end

	if not ok then
		-- Almost always the script-injection permission prompt being declined.
		return false, "could not write the script source (allow Bloxwright script access when Studio asks): " .. tostring(setErr)
	end

	Selection:Set({ target })
	return true, string.format("%s %s", verb, instancePath(target))
end

--[[
	Find something that already exists, without creating anything on the way.
	Used by the read/modify/delete jobs, where auto-creating a missing folder
	would quietly hide the fact that the model guessed a wrong path.
]]
local function resolveExisting(path: string): (Instance?, string?)
	local parts = splitPath(path)
	if #parts == 0 then
		return nil, "empty path"
	end

	local rootName = parts[1]
	local node: Instance
	if string.lower(rootName) == "selection" then
		local selected = Selection:Get()
		if #selected == 0 then
			return nil, "nothing is selected in Studio"
		end
		node = selected[1]
	elseif ROOTS[rootName] then
		local ok, service = pcall(function()
			return game:GetService(rootName)
		end)
		if not ok or not service then
			return nil, string.format("could not get service '%s'", rootName)
		end
		node = service
	else
		return nil, string.format("'%s' is not a place container I can read", rootName)
	end

	for index = 2, #parts do
		local child = node:FindFirstChild(parts[index])
		if not child then
			return nil, string.format("'%s' does not exist under %s", parts[index], instancePath(node))
		end
		node = child
	end
	return node, nil
end

local function applyInstance(job): (boolean, string)
	local className = tostring(job.className or "")
	if className == "" then
		return false, "no ClassName given"
	end

	local parent, name, err = resolveTarget(job.path or "")
	if not parent or not name then
		return false, err or "could not resolve that path"
	end

	local recording = ChangeHistoryService:TryBeginRecording("Bloxwright: " .. name)

	local existing = parent:FindFirstChild(name)
	local target: Instance
	local verb: string
	if existing and existing.ClassName == className then
		target = existing
		verb = "updated"
	else
		if existing then
			existing:Destroy()
		end
		local created
		local ok, createErr = pcall(function()
			created = Instance.new(className)
		end)
		if not ok or not created then
			if recording then
				ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
			end
			return false, string.format("'%s' is not a class I can create (%s)", className, tostring(createErr))
		end
		created.Name = name
		created.Parent = parent
		target = created
		verb = "created"
	end

	local failures = applyProperties(target, job.properties)

	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end

	local summary = string.format("%s %s (%s)", verb, instancePath(target), className)
	if #failures > 0 then
		return true, summary .. " — these properties did not apply: " .. table.concat(failures, ", ")
	end
	return true, summary
end

local function applyPropertyJob(job): (boolean, string)
	local target, err = resolveExisting(job.path or "")
	if not target then
		return false, err or "not found"
	end
	local recording = ChangeHistoryService:TryBeginRecording("Bloxwright: properties")
	local failures = applyProperties(target, job.properties)
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	if #failures > 0 then
		return true, string.format("updated %s — these did not apply: %s", instancePath(target), table.concat(failures, ", "))
	end
	return true, "updated " .. instancePath(target)
end

local function applyDelete(job): (boolean, string)
	local target, err = resolveExisting(job.path or "")
	if not target then
		return false, err or "not found"
	end
	-- A service is not the model's to remove, and Destroy on one either errors
	-- or does something nobody wants.
	if target.Parent == game then
		return false, "refusing to delete the service " .. target.Name
	end
	local removed = instancePath(target)
	local recording = ChangeHistoryService:TryBeginRecording("Bloxwright: delete " .. target.Name)
	target:Destroy()
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	return true, "deleted " .. removed
end

local function applyTree(job): (boolean, string, any)
	local root, err = resolveExisting(job.path or "")
	if not root then
		return false, err or "not found"
	end

	local maxDepth = math.clamp(tonumber(job.depth) or 2, 1, 4)
	local nodes = {}
	local truncated = false

	local function walk(instance: Instance, depth: number)
		if depth > maxDepth or truncated then
			return
		end
		for _, child in ipairs(instance:GetChildren()) do
			if #nodes >= 200 then
				truncated = true
				return
			end
			table.insert(nodes, { path = instancePath(child), className = child.ClassName })
			walk(child, depth + 1)
		end
	end
	walk(root, 1)

	return true, string.format("%s has %d descendant(s) within depth %d%s",
		instancePath(root), #nodes, maxDepth, truncated and " (truncated at 200)" or ""),
		{ root = instancePath(root), children = nodes }
end

--[[
	Inserting a catalog asset.

	Only Models can be brought in with InsertService:LoadAsset — an image, a
	sound or a mesh is a *reference* you point an instance at, not something
	that can be inserted on its own. So the first thing we do is ask what the
	ID actually is, and then build the right instance for it. Getting this wrong
	is the difference between "here's your sword" and a red error about an
	asset type that was never insertable.

	AssetTypeIds from the Roblox asset-type table.
]]
local ASSET_STRATEGY = {
	[1] = "image",
	[3] = "audio",
	[4] = "mesh",
	[10] = "model",
	[13] = "decal",
	[24] = "animation",
	[38] = "model", -- Plugin
	[40] = "meshpart",
}

local function assetInfo(assetId: number): (string?, number?)
	local ok, info = pcall(function()
		return MarketplaceService:GetProductInfo(assetId)
	end)
	if ok and type(info) == "table" then
		return info.Name, tonumber(info.AssetTypeId)
	end
	return nil, nil
end

--[[ LoadAsset hands back a Model wrapper. A single-child wrapper is just
	packaging, so unwrap it; several children means the wrapper is the model. ]]
local function unwrapLoaded(wrapper: Instance, parent: Instance, assetName: string?): Instance
	local children = wrapper:GetChildren()
	if #children == 1 then
		local only = children[1]
		only.Parent = parent
		wrapper:Destroy()
		return only
	end
	wrapper.Name = assetName or wrapper.Name
	wrapper.Parent = parent
	return wrapper
end

local function applyAsset(job): (boolean, string, any)
	local assetId = tonumber(job.assetId)
	if not assetId or assetId <= 0 then
		return false, "that is not an asset id", nil
	end

	local parent, err = resolveExisting(job.path or "Workspace")
	if not parent then
		return false, err or "could not find where to put it", nil
	end

	local assetName, assetTypeId = assetInfo(assetId)
	-- An explicit kind from the caller wins; otherwise go with what the
	-- catalog says; and if the lookup failed (offline, private asset), a Model
	-- is the only thing worth attempting.
	local strategy = job.assetKind or ASSET_STRATEGY[assetTypeId or -1] or "model"
	local label = assetName and string.format('"%s"', assetName) or ("asset " .. assetId)
	local reference = "rbxassetid://" .. assetId

	local recording = ChangeHistoryService:TryBeginRecording("Bloxwright: insert " .. label)
	local function abandon(message: string): (boolean, string, any)
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
		end
		return false, message, nil
	end

	local created: Instance? = nil

	if strategy == "model" then
		local ok, loaded = pcall(function()
			return InsertService:LoadAsset(assetId)
		end)
		if not ok or not loaded then
			return abandon(string.format(
				"could not load %s — it has to be public, or owned by the account Studio is signed into (%s)",
				label, tostring(loaded)))
		end
		created = unwrapLoaded(loaded, parent, assetName)

	elseif strategy == "image" or strategy == "decal" then
		-- On a part, an image belongs on a Decal; in a GUI, on an ImageLabel.
		if parent:IsA("BasePart") then
			local decal = Instance.new("Decal")
			decal.Texture = reference
			decal.Name = assetName or "Decal"
			decal.Parent = parent
			created = decal
		else
			local image = Instance.new("ImageLabel")
			image.Image = reference
			image.Name = assetName or "Image"
			image.Size = UDim2.fromOffset(200, 200)
			image.BackgroundTransparency = 1
			image.Parent = parent
			created = image
		end

	elseif strategy == "audio" then
		local sound = Instance.new("Sound")
		sound.SoundId = reference
		sound.Name = assetName or "Sound"
		sound.Parent = parent
		created = sound

	elseif strategy == "animation" then
		local animation = Instance.new("Animation")
		animation.AnimationId = reference
		animation.Name = assetName or "Animation"
		animation.Parent = parent
		created = animation

	elseif strategy == "meshpart" then
		local ok, meshPart = pcall(function()
			return InsertService:CreateMeshPartAsync(reference, Enum.CollisionFidelity.Default, Enum.RenderFidelity.Automatic)
		end)
		if ok and meshPart then
			meshPart.Name = assetName or "MeshPart"
			meshPart.Parent = parent
			created = meshPart
		else
			return abandon(string.format("could not build a MeshPart from %s (%s)", label, tostring(meshPart)))
		end

	elseif strategy == "mesh" then
		-- A classic Mesh is a shape applied to a part, not a part itself.
		local part = Instance.new("Part")
		part.Name = assetName or "Mesh"
		part.Anchored = true
		local mesh = Instance.new("SpecialMesh")
		mesh.MeshType = Enum.MeshType.FileMesh
		mesh.MeshId = reference
		mesh.Parent = part
		part.Parent = parent
		created = part

	else
		return abandon(string.format("'%s' is not an asset kind I know how to insert", tostring(strategy)))
	end

	if not created then
		return abandon("nothing was inserted")
	end

	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end

	-- Select it so the user's eye lands on the thing that just appeared.
	pcall(function()
		Selection:Set({ created })
	end)

	return true,
		string.format("inserted %s as %s at %s", label, created.ClassName, instancePath(created)),
		{ path = instancePath(created), className = created.ClassName, assetId = assetId, name = assetName }
end

--[[ Route a job to its handler. Returns ok, message, optional data. ]]
local function dispatch(job): (boolean, string, any)
	local kind = job.kind or "script"
	if kind == "script" then
		local ok, message = applyJob(job)
		return ok, message, nil
	elseif kind == "instance" then
		local ok, message = applyInstance(job)
		return ok, message, nil
	elseif kind == "properties" then
		local ok, message = applyPropertyJob(job)
		return ok, message, nil
	elseif kind == "delete" then
		local ok, message = applyDelete(job)
		return ok, message, nil
	elseif kind == "tree" then
		return applyTree(job)
	elseif kind == "asset" then
		return applyAsset(job)
	end
	return false, string.format("unknown job kind '%s'", tostring(kind)), nil
end

-- Walking the DataModel is the expensive part of a snapshot: Workspace alone
-- can hold tens of thousands of instances, and this runs inside someone's
-- editor. Selection is cheap and changes constantly, so it's read every tick;
-- the script inventory is cached and refreshed occasionally.
local TREE_REFRESH_SECONDS = 30
local cachedTree = {}
local treeStamp = 0

local function scanScripts()
	local tree = {}
	local containers = {
		game:GetService("ServerScriptService"),
		game:GetService("ServerStorage"),
		game:GetService("ReplicatedStorage"),
		game:GetService("StarterPlayer"),
		game:GetService("StarterGui"),
		game:GetService("Workspace"),
	}
	for _, container in ipairs(containers) do
		for _, descendant in ipairs(container:GetDescendants()) do
			if SCRIPT_CLASSES[descendant.ClassName] then
				table.insert(tree, {
					path = instancePath(descendant),
					className = descendant.ClassName,
				})
				if #tree >= 60 then
					break
				end
			end
		end
		if #tree >= 60 then
			break
		end
	end
	return tree
end

--[[
	A small inventory of the place: what's selected, and which scripts already
	exist. Capped hard — this rides on every request to the model, so a huge
	place should cost the same as a small one.
]]
local function snapshot()
	local selection = {}
	for _, instance in ipairs(Selection:Get()) do
		table.insert(selection, {
			path = instancePath(instance),
			className = instance.ClassName,
		})
		if #selection >= 10 then
			break
		end
	end

	local now = os.clock()
	if now - treeStamp > TREE_REFRESH_SECONDS or treeStamp == 0 then
		cachedTree = scanScripts()
		treeStamp = now
	end

	return {
		version = PLUGIN_VERSION,
		place = game.Name,
		selection = selection,
		tree = cachedTree,
	}
end

local function post(path: string, body)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE_URL .. path,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode(body),
		})
	end)
	if not ok or not response.Success then
		return nil
	end
	local decoded, result = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	return decoded and result or nil
end

--[[ Returns whether the app was reachable, and whether it gave us work. ]]
local function tick(): (boolean, boolean)
	local reply = post("/poll", snapshot())
	if not reply then
		return false, false
	end
	local jobs = reply.jobs or {}
	for _, job in ipairs(jobs) do
		local ok, message, data = dispatch(job)
		log(ok and message or ("failed: " .. message))
		post("/result", {
			id = job.id,
			ok = ok,
			error = (not ok) and message or nil,
			message = ok and message or nil,
			data = data,
			path = job.path,
		})
	end
	return true, #jobs > 0
end

local function setConnected(value: boolean)
	connected = value
	button:SetActive(connected)

	if not connected then
		log("disconnected")
		loopToken += 1
		return
	end

	loopToken += 1
	local myToken = loopToken
	log("connected — polling " .. BASE_URL)

	task.spawn(function()
		local warned = false
		while connected and loopToken == myToken do
			local reached, didWork = tick()
			if not reached and not warned then
				warned = true
				log("can't reach the Bloxwright app — is it running? (" .. BASE_URL .. ")")
			elseif reached and warned then
				warned = false
				log("reconnected to the Bloxwright app")
			end
			task.wait(didWork and BUSY_POLL_SECONDS or POLL_SECONDS)
		end
	end)
end

local AUTO_SETTING = "bloxwright_autoconnect"

button.Click:Connect(function()
	local wanted = not connected
	setConnected(wanted)
	-- Remember the choice: turning it off should stay off across restarts,
	-- and turning it back on shouldn't need clicking again tomorrow.
	plugin:SetSetting(AUTO_SETTING, wanted)
end)

plugin.Unloading:Connect(function()
	connected = false
	loopToken += 1
end)

-- Connect on load rather than waiting to be clicked. Having to click a button
-- before the app can see Studio at all is the difference between "it detects
-- Studio" and "it detects Studio, eventually, if you know the trick".
-- Playtests are skipped; the edit-mode session is the one that matters.
if not RunService:IsRunning() then
	local auto = plugin:GetSetting(AUTO_SETTING)
	if auto == nil then
		auto = true
	end
	if auto then
		setConnected(true)
	else
		log("loaded, auto-connect is off. Click the Bloxwright button to connect.")
	end
end
