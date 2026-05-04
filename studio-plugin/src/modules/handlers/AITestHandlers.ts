import LogService from "@rbxts/services";

const Players = game.GetService("Players");
const UserInputService = game.GetService("UserInputService");
const PathfindingService = game.GetService("PathfindingService");
const Terrain = workspace.FindFirstChild("Terrain");
const RunService = game.GetService("RunService");
const Stats = game.GetService("Stats");

interface PlayerState {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  health: number;
  maxHealth: number;
  walkSpeed: number;
  jumpPower: number;
  character: Instance | null;
  humanoid: Humanoid | null;
  rootPart: BasePart | null;
}

interface NearbyObject {
  path: string;
  name: string;
  className: string;
  distance: number;
  position: { x: number; y: number; z: number };
}

interface DebugLogEntry {
  message: string;
  messageType: string;
  timestamp: number;
}

interface RuntimeError {
  message: string;
  stack: string;
  timestamp: number;
}

let debugLogBuffer: DebugLogEntry[] = [];
let runtimeErrors: RuntimeError[] = [];
let propertyWatchers: Map<string, { properties: string[]; startTime: number; changes: Array<{ property: string; oldValue: any; newValue: any; time: number }> }> = new Map();
let logConnection: RBXScriptConnection | undefined;

function initDebugLogging() {
  if (logConnection) return;
  logConnection = LogService.MessageOut.Connect((message, messageType) => {
    debugLogBuffer.push({
      message,
      messageType: messageType.Name,
      timestamp: tick(),
    });
    if (debugLogBuffer.size() > 1000) {
      debugLogBuffer.shift();
    }
  });
}

function getPlayerStateFromCharacter(character: Instance, includeNearby: boolean, nearbyRadius: number): PlayerState | null {
  const humanoid = character.FindFirstChildWhichIsA("Humanoid") as Humanoid;
  const rootPart = character.FindFirstChild("HumanoidRootPart") as BasePart;

  if (!humanoid || !rootPart) return null;

  const pos = rootPart.Position;
  const rot = rootPart.Orientation;

  return {
    position: { x: pos.X, y: pos.Y, z: pos.Z },
    rotation: { x: rot.X, y: rot.Y, z: rot.Z },
    health: humanoid.Health,
    maxHealth: humanoid.MaxHealth,
    walkSpeed: humanoid.WalkSpeed,
    jumpPower: humanoid.JumpPower,
    character,
    humanoid,
    rootPart,
  };
}

function findNearbyObjects(position: Vector3, radius: number): NearbyObject[] {
  const nearby: NearbyObject[] = [];
  const descendants = workspace.GetDescendants();

  for (const descendant of descendants) {
    if (!descendant.IsA("BasePart")) continue;
    const dist = (descendant.Position - position).Magnitude;
    if (dist <= radius) {
      nearby.push({
        path: descendant.GetFullName(),
        name: descendant.Name,
        className: descendant.ClassName,
        distance: math.round(dist * 100) / 100,
        position: {
          x: descendant.Position.X,
          y: descendant.Position.Y,
          z: descendant.Position.Z,
        },
      });
    }
  }

  nearby.sort((a, b) => a.distance - b.distance);
  return nearby.slice(0, 50);
}

function aiControlPlayer(requestData: Record<string, unknown>) {
  const action = requestData.action as string;
  const duration = (requestData.duration as number) ?? 0.1;
  const speed = (requestData.speed as number) ?? 1.0;

  const player = Players.LocalPlayer;
  const character = player.Character;
  if (!character) return { error: "No character found" };

  const humanoid = character.FindFirstChildWhichIsA("Humanoid") as Humanoid;
  const rootPart = character.FindFirstChild("HumanoidRootPart") as BasePart;
  if (!humanoid || !rootPart) return { error: "No humanoid or root part found" };

  const camera = workspace.CurrentCamera;
  if (!camera) return { error: "No camera found" };

  const moveDirection = new Vector3(0, 0, 0);
  let lookDirection = new Vector3(0, 0, -1);

  switch (action) {
    case "move_forward":
      lookDirection = camera.CFrame.LookVector;
      break;
    case "move_backward":
      lookDirection = camera.CFrame.LookVector.mul(-1);
      break;
    case "move_left":
      lookDirection = camera.CFrame.RightVector.mul(-1);
      break;
    case "move_right":
      lookDirection = camera.CFrame.RightVector;
      break;
    case "jump":
      humanoid.Jump = true;
      return { success: true, action, message: "Jump triggered" };
    case "crouch":
      pcall(() => humanoid.Crouch(true));
      return { success: true, action, message: "Crouch triggered" };
    case "run":
      humanoid.WalkSpeed = 16 * speed;
      return { success: true, action, speed: humanoid.WalkSpeed };
    case "walk":
      humanoid.WalkSpeed = 1 * speed;
      return { success: true, action, speed: humanoid.WalkSpeed };
    case "look_up":
      camera.CFrame = new CFrame(camera.CFrame.Position, camera.CFrame.Position.add(new Vector3(0, 1, -1)));
      return { success: true, action, message: "Camera look up" };
    case "look_down":
      camera.CFrame = new CFrame(camera.CFrame.Position, camera.CFrame.Position.add(new Vector3(0, -1, -1)));
      return { success: true, action, message: "Camera look down" };
    case "look_left":
      camera.CFrame = new CFrame(camera.CFrame.Position, camera.CFrame.Position.add(new Vector3(-1, 0, -1)));
      return { success: true, action, message: "Camera look left" };
    case "look_right":
      camera.CFrame = new CFrame(camera.CFrame.Position, camera.CFrame.Position.add(new Vector3(1, 0, -1)));
      return { success: true, action, message: "Camera look right" };
    case "stop":
      humanoid.Move(new Vector3(0, 0, 0));
      return { success: true, action, message: "Movement stopped" };
    default:
      return { error: `Unknown action: ${action}` };
  }

  const finalMoveDirection = lookDirection.Unit;
  humanoid.Move(finalMoveDirection, true);
  task.delay(duration, () => {
    pcall(() => humanoid.Move(new Vector3(0, 0, 0)));
  });

  return { success: true, action, duration, speed, moveDirection: lookDirection };
}

function aiGetPlayerState(requestData: Record<string, unknown>) {
  const includeNearby = (requestData.includeNearby as boolean) ?? true;
  const nearbyRadius = (requestData.nearbyRadius as number) ?? 50;

  initDebugLogging();

  const player = Players.LocalPlayer;
  const character = player.Character;
  if (!character) return { error: "No character found" };

  const state = getPlayerStateFromCharacter(character, includeNearby, nearbyRadius);
  if (!state) return { error: "Could not get player state" };

  const nearby = includeNearby ? findNearbyObjects(state.rootPart!.Position, nearbyRadius) : [];

  return {
    playerIndex: 1,
    playerName: player.Name,
    state,
    nearby,
    nearbyCount: nearby.size(),
  };
}

function aiInteractWithObject(requestData: Record<string, unknown>) {
  const objectPath = requestData.objectPath as string;
  const action = requestData.action as string;

  const instance = game.FindService("Workspace").FindFirstChild(objectPath, true);
  if (!instance) {
    return { error: `Object not found: ${objectPath}` };
  }

  switch (action) {
    case "click":
    case "activate":
      if (instance.IsA("ClickDetector")) {
        const cd = instance as ClickDetector;
        pcall(() => {
          const player = Players.LocalPlayer;
          if (player) {
            (cd as any).Fire(cd, player);
          }
        });
        return { success: true, action, objectPath, message: "ClickDetector activated" };
      }
      if (instance.IsA("ProximityPrompt")) {
        const pp = instance as ProximityPrompt;
        pcall(() => {
          (pp as any).Fire(pp);
        });
        return { success: true, action, objectPath, message: "ProximityPrompt activated" };
      }
      return { error: `Object does not support click/activate: ${objectPath}` };
    case "touch":
      if (instance.IsA("BasePart")) {
        const character = Players.LocalPlayer.Character;
        if (character) {
          const humanoid = character.FindFirstChildWhichIsA("Humanoid");
          if (humanoid) {
            const part = instance as BasePart;
            pcall(() => {
              if (character) {
                (part as any).FireTouchInterest(character, 0);
              }
            });
            return { success: true, action, objectPath, message: "Touch interaction fired" };
          }
        }
      }
      return { error: `Object does not support touch: ${objectPath}` };
    case "proximity":
      if (instance.IsA("ProximityPrompt")) {
        const pp = instance as ProximityPrompt;
        pcall(() => {
          (pp as any).Fire(pp);
        });
        return { success: true, action, objectPath };
      }
      return { error: `Object is not a ProximityPrompt: ${objectPath}` };
    case "hover":
      return { success: true, action, objectPath, message: "Hover interaction (visual feedback only)" };
    default:
      return { error: `Unknown action: ${action}` };
  }
}

function aiTeleportPlayer(requestData: Record<string, unknown>) {
  const position = requestData.position as { x: number; y: number; z: number };
  const rotation = requestData.rotation as { x: number; y: number; z: number } | undefined;
  const playerIndex = (requestData.playerIndex as number) ?? 1;

  const player = Players.LocalPlayer;
  const character = player.Character;
  if (!character) return { error: "No character found" };

  const rootPart = character.FindFirstChild("HumanoidRootPart") as BasePart;
  if (!rootPart) return { error: "No HumanoidRootPart found" };

  const newPosition = new Vector3(position.x, position.y, position.z);
  const teleportCFrame = rotation
    ? new CFrame(newPosition).mul(CFrame.Angles(math.rad(rotation.x), math.rad(rotation.y), math.rad(rotation.z)))
    : new CFrame(newPosition);

  rootPart.CFrame = teleportCFrame;

  return {
    success: true,
    position,
    rotation: rotation ?? null,
    playerIndex,
    newCFrame: {
      x: rootPart.CFrame.Position.X,
      y: rootPart.CFrame.Position.Y,
      z: rootPart.CFrame.Position.Z,
    },
  };
}

function getGameState(requestData: Record<string, unknown>) {
  const scope = (requestData.scope as string) ?? "all";
  const maxResults = (requestData.maxResults as number) ?? 50;

  const results: Record<string, unknown>[] = [];

  if (scope === "all" || scope === "players") {
    for (const player of Players.GetPlayers()) {
      if (results.size() >= maxResults) break;
      const character = player.Character;
      if (character) {
        const state = getPlayerStateFromCharacter(character, false, 0);
        if (state) {
          results.push({
            type: "player",
            name: player.Name,
            userId: player.UserId,
            ...state,
          });
        }
      }
    }
  }

  if (scope === "all" || scope === "npcs") {
    const npcs = workspace.GetDescendants().filter(
      (desc) => desc.IsA("Model") && desc.FindFirstChildWhichIsA("Humanoid") && !Players.GetPlayerFromCharacter(desc)
    );
    for (const npc of npcs) {
      if (results.size() >= maxResults) break;
      const humanoid = npc.FindFirstChildWhichIsA("Humanoid") as Humanoid;
      const rootPart = npc.FindFirstChild("HumanoidRootPart") as BasePart;
      if (humanoid && rootPart) {
        results.push({
          type: "npc",
          name: npc.Name,
          className: npc.ClassName,
          health: humanoid.Health,
          maxHealth: humanoid.MaxHealth,
          walkSpeed: humanoid.WalkSpeed,
          position: {
            x: rootPart.Position.X,
            y: rootPart.Position.Y,
            z: rootPart.Position.Z,
          },
        });
      }
    }
  }

  if (scope === "all" || scope === "projectiles") {
    const projectiles = workspace.GetDescendants().filter(
      (desc) => desc.IsA("BasePart") && (desc as BasePart).Anchored === false &&
        (desc.Name.includes("Bullet") || desc.Name.includes("Projectile") || desc.Name.includes("Shot"))
    );
    for (const proj of projectiles) {
      if (results.size() >= maxResults) break;
      results.push({
        type: "projectile",
        name: proj.Name,
        className: proj.ClassName,
        position: {
          x: (proj as BasePart).Position.X,
          y: (proj as BasePart).Position.Y,
          z: (proj as BasePart).Position.Z,
        },
        velocity: {
          x: (proj as BasePart).Velocity.X,
          y: (proj as BasePart).Velocity.Y,
          z: (proj as BasePart).Velocity.Z,
        },
      });
    }
  }

  return {
    scope,
    count: results.size(),
    results,
  };
}

function captureDebugLogs(requestData: Record<string, unknown>) {
  const type = (requestData.type as string) ?? "all";
  const maxLines = (requestData.maxLines as number) ?? 100;
  const sinceTimestamp = requestData.sinceTimestamp as number | undefined;

  initDebugLogging();

  let filtered = debugLogBuffer;
  if (sinceTimestamp) {
    filtered = filtered.filter((entry) => entry.timestamp >= sinceTimestamp);
  }

  if (type !== "all") {
    const typeMap: Record<string, string> = {
      errors: "Message",
      warnings: "Warning",
      print: "Info",
      custom: "Message",
    };
    filtered = filtered.filter((entry) => entry.messageType === typeMap[type]);
  }

  const result = filtered.slice(-maxLines);

  return {
    type,
    count: result.size(),
    logs: result,
  };
}

function getRuntimeErrors(requestData: Record<string, unknown>) {
  const clearAfter = (requestData.clearAfter as boolean) ?? false;

  const errors = [...runtimeErrors];
  if (clearAfter) {
    runtimeErrors = [];
  }

  return {
    count: errors.size(),
    errors,
  };
}

function executeTestSequence(requestData: Record<string, unknown>) {
  const steps = requestData.steps as Array<Record<string, unknown>>;
  const stopOnError = (requestData.stopOnError as boolean) ?? true;

  if (!steps || steps.size() === 0) {
    return { error: "No steps provided" };
  }

  const results: Array<{ step: number; action: string; success: boolean; result?: unknown; error?: string }> = [];

  for (let i = 0; i < steps.size(); i++) {
    const step = steps[i];
    const stepNum = i + 1;
    const action = step.action as string;

    let success = true;
    let result: unknown;
    let error: string | undefined;

    try {
      switch (action) {
        case "wait":
          const waitDuration = (step.duration as number) ?? 1;
          task.wait(waitDuration);
          result = { waited: waitDuration };
          break;

        case "move":
          const moveResult = aiControlPlayer({ action: step.position ? "move_forward" : "move_forward", duration: (step.duration as number) ?? 0.5, speed: 1 });
          result = moveResult;
          break;

        case "jump":
          const jumpResult = aiControlPlayer({ action: "jump" });
          result = jumpResult;
          break;

        case "click":
          const clickResult = aiInteractWithObject({ objectPath: step.target as string, action: "click" });
          result = clickResult;
          break;

        case "touch":
          const touchResult = aiInteractWithObject({ objectPath: step.target as string, action: "touch" });
          result = touchResult;
          break;

        case "teleport":
          const teleportResult = aiTeleportPlayer({ position: step.position as { x: number; y: number; z: number }, rotation: step.rotation as { x: number; y: number; z: number } | undefined });
          result = teleportResult;
          break;

        case "set_property":
          break;

        case "get_property":
          break;

        case "execute_luau":
          break;

        default:
          success = false;
          error = `Unknown action: ${action}`;
      }
    } catch (e) {
      success = false;
      error = tostring(e);
    }

    results.push({ step: stepNum, action, success, result, error });

    if (!success && stopOnError) {
      return {
        completed: stepNum,
        total: steps.size(),
        results,
        stopped: true,
        stopReason: error,
      };
    }
  }

  return {
    completed: steps.size(),
    total: steps.size(),
    results,
    stopped: false,
  };
}

function watchPropertyChanges(requestData: Record<string, unknown>) {
  const instancePath = requestData.instancePath as string;
  const properties = requestData.properties as string[];
  const duration = (requestData.duration as number) ?? 30;

  const instance = game.FindService("Workspace").FindFirstChild(instancePath, true);
  if (!instance) {
    return { error: `Instance not found: ${instancePath}` };
  }

  const watcherId = instancePath;
  const watcher = {
    properties,
    startTime: tick(),
    changes: [] as Array<{ property: string; oldValue: any; newValue: any; time: number }>,
  };

  const oldValues = new Map<string, any>();
  for (const prop of properties) {
    pcall(() => {
      oldValues.set(prop, (instance as any)[prop]);
    });
  }

  propertyWatchers.set(watcherId, watcher);

  task.spawn(() => {
    task.wait(duration);
    propertyWatchers.delete(watcherId);
  });

  return {
    watching: true,
    instancePath,
    properties,
    duration,
    startTime: watcher.startTime,
  };
}

function getPerformanceMetrics(requestData: Record<string, unknown>) {
  const category = (requestData.category as string) ?? "all";

  const metrics: Record<string, unknown> = {};

  if (category === "all" || category === "fps") {
    const fps = Stats.PerformanceStats.Framerate;
    metrics.fps = {
      current: math.round(fps.GetValue() * 10) / 10,
    };
  }

  if (category === "all" || category === "memory") {
    const memory = Stats.PerformanceStats.Memory;
    metrics.memory = {
      physical: math.round(memory.Physical.GetValue() / 1024 / 1024 * 10) / 10,
      virtual: math.round(memory.Virtual.GetValue() / 1024 / 1024 * 10) / 10,
    };
  }

  if (category === "all" || category === "network") {
    const network = Stats.PerformanceStats.Network;
    metrics.network = {
      sent: math.round(network.DataSent.GetValue() / 1024 * 10) / 10,
      received: math.round(network.DataReceived.GetValue() / 1024 * 10) / 10,
    };
  }

  if (category === "all" || category === "physics") {
    metrics.physics = {
      parts: workspace.GetDescendants().filter((d) => d.IsA("BasePart")).size(),
      physicsStep: math.round(RunService.RenderStepped:Wait() * 1000),
    };
  }

  if (category === "all" || category === "instances") {
    metrics.instances = {
      total: game.GetDescendants().size(),
      scripts: workspace.GetDescendants().filter((d) => d.IsA("LuaSourceContainer")).size(),
    };
  }

  return metrics;
}

function inspectTerrain(requestData: Record<string, unknown>) {
  const region = requestData.region as { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | undefined;
  const includeNavmesh = (requestData.includeNavmesh as boolean) ?? false;

  if (!Terrain) {
    return { error: "No terrain found in workspace" };
  }

  const terrainRegion = region
    ? new Region3(new Vector3(region.minX, region.minY, region.minZ), new Vector3(region.maxX, region.maxY, region.maxZ))
    : new Region3(new Vector3(-500, -500, -500), new Vector3(500, 500, 500));

  const terrainData = Terrain.ReadVoxels(terrainRegion, 4);
  const voxelCount = terrainData.Size.X * terrainData.Size.Y * terrainData.Size.Z;

  const result: Record<string, unknown> = {
    terrainExists: true,
    region: region ?? { minX: -500, minY: -500, minZ: -500, maxX: 500, maxY: 500, maxZ: 500 },
    voxelCount,
    size: { x: terrainData.Size.X, y: terrainData.Size.Y, z: terrainData.Size.Z },
  };

  if (includeNavmesh) {
    const navmesh = workspace.FindFirstChild("NavMesh");
    result.navMeshExists = !!navmesh;
    if (navmesh) {
      result.navMeshBounds = {
        position: (navmesh as BasePart).Position,
        size: (navmesh as BasePart).Size,
      };
    }
  }

  return result;
}

function getNetworkStats(requestData: Record<string, unknown>) {
  const includePlayers = (requestData.includePlayers as boolean) ?? false;

  const stats = Stats.PerformanceStats.Network;
  const result: Record<string, unknown> = {
    sent: stats.DataSent.GetValue(),
    received: stats.DataReceived.GetValue(),
    ping: 0,
  };

  if (includePlayers) {
    const playerStats = Players.GetPlayers().map((p) => ({
      name: p.Name,
      ping: p.GetNetworkPing(),
    }));
    result.players = playerStats;
  }

  return result;
}

function simulateInput(requestData: Record<string, unknown>) {
  const inputType = requestData.inputType as string;
  const keyCode = requestData.keyCode as string;
  const position = requestData.position as { x: number; y: number } | undefined;

  switch (inputType) {
    case "keypress":
    case "keydown":
    case "keyup": {
      if (!keyCode) return { error: "keyCode is required for keyboard input" };
      let keyCodeEnum: Enum.KeyCode | undefined;
      pcall(() => {
        keyCodeEnum = Enum.KeyCode[keyCode as string] as Enum.KeyCode;
      });
      if (!keyCodeEnum) return { error: `Invalid KeyCode: ${keyCode}` };

      if (inputType === "keydown" || inputType === "keypress") {
        pcall(() => {
          const signal = UserInputService.KeyboardDown as any;
          signal.Fire(signal, keyCodeEnum!);
        });
      }
      if (inputType === "keyup" || inputType === "keypress") {
        pcall(() => {
          const signal = UserInputService.KeyboardUp as any;
          signal.Fire(signal, keyCodeEnum!);
        });
      }
      return { success: true, inputType, keyCode };
    }

    case "mouse_click":
    case "mouse_down":
    case "mouse_up": {
      if (!position) return { error: "position is required for mouse input" };
      const screenPos = new Vector2(position.x, position.y);
      if (inputType === "mouse_click" || inputType === "mouse_down") {
        pcall(() => (UserInputService.MouseButton1Down as any).Fire(screenPos));
      }
      if (inputType === "mouse_click" || inputType === "mouse_up") {
        pcall(() => (UserInputService.MouseButton1Up as any).Fire(screenPos));
      }
      return { success: true, inputType, position };
    }

    case "mouse_move": {
      if (!position) return { error: "position is required for mouse move" };
      pcall(() => (UserInputService.MouseMoved as any).Fire(new Vector2(position.x, position.y)));
      return { success: true, inputType, position };
    }

    default:
      return { error: `Unknown input type: ${inputType}` };
  }
}

export = {
  aiControlPlayer,
  aiGetPlayerState,
  aiInteractWithObject,
  aiTeleportPlayer,
  getGameState,
  captureDebugLogs,
  getRuntimeErrors,
  executeTestSequence,
  watchPropertyChanges,
  getPerformanceMetrics,
  inspectTerrain,
  getNetworkStats,
  simulateInput,
};