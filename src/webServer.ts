import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Server, Socket } from "socket.io";
import {
  createInitialGameState,
  flipCard,
  getLegalActions,
  getPlayerPrivateStatus,
  loadRulesFromFile,
  NO_INSPECT_TARGET_PLAYER_ID,
  resolvePendingChoice,
  resolvePendingReaction,
} from "./index.js";
import { GameState, ResolveChoiceInput } from "./models.js";

type RoomStatus = "lobby" | "playing" | "ended";

interface RoomPlayer {
  socket_id: string;
  display_name: string;
  ready: boolean;
  player_id: string | null;
}

interface Room {
  id: string;
  host_socket_id: string;
  status: RoomStatus;
  players: RoomPlayer[];
  state: GameState | null;
}

interface LabeledOption {
  value: string;
  label: string;
}

const PORT = Number(process.env.PORT ?? 3000);
const rulesPath = join(process.cwd(), "rules", "basic-rules.json");
const rules = loadRulesFromFile(rulesPath);
const indexHtmlPath = join(process.cwd(), "web", "index.html");
const indexHtml = readFileSync(indexHtmlPath, { encoding: "utf8" });
const runtimeConfigPath = join(process.cwd(), "web", "runtime-config.js");
const runtimeConfigJs = readFileSync(runtimeConfigPath, { encoding: "utf8" });

const rooms = new Map<string, Room>();
const socketRoomMap = new Map<string, string>();

function parseCorsOrigins(): string[] | string {
  const raw = String(process.env.CORS_ORIGINS ?? "").trim();
  if (!raw || raw === "*") {
    return "*";
  }
  const origins = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : "*";
}

const corsOrigin = parseCorsOrigins();

function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().slice(0, 24);
}

function createRoomId(): string {
  while (true) {
    const id = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    if (!rooms.has(id)) {
      return id;
    }
  }
}

function findRoomBySocket(socketId: string): Room | null {
  const roomId = socketRoomMap.get(socketId);
  if (!roomId) {
    return null;
  }
  return rooms.get(roomId) ?? null;
}

function findRoomPlayer(room: Room, socketId: string): RoomPlayer | null {
  return room.players.find((player) => player.socket_id === socketId) ?? null;
}

function isRoomPlayable(room: Room): boolean {
  return room.status === "playing" && !!room.state;
}

function createLabeledOptions(
  state: GameState,
  _room: Room,
  choice: NonNullable<GameState["pending_choice"]>,
): LabeledOption[] {
  return choice.options.map((value, index) => {
    if (choice.kind === "option") {
      if (choice.choice_id === "normal_sleep_gas_confirm" && value === "confirm_shuffle") {
        return { value, label: "触发催眠瓦斯" };
      }
    }

    if (choice.kind === "target_player" || choice.kind === "target_player_with_key") {
      if (value === NO_INSPECT_TARGET_PLAYER_ID) {
        return { value, label: "谁都不看（宣告为空房间并放回）" };
      }
      const target = state.players.find((player) => player.id === value);
      return {
        value,
        label: target ? `${target.name} (${target.id})` : value,
      };
    }

    if (choice.kind === "board_card") {
      const slotIndex = state.board_slots.findIndex((slot) => slot === value);
      const displayIndex = slotIndex >= 0 ? slotIndex + 1 : index + 1;
      return { value, label: `未知房间 #${displayIndex}` };
    }

    if (choice.kind === "three_keys") {
      return { value, label: `背面钥匙候选 ${index + 1}` };
    }

    if (choice.kind === "target_player_key") {
      return { value, label: `目标背面钥匙 #${index + 1}` };
    }

    return { value, label: value };
  });
}

function createEventView(state: GameState, viewerPlayerId: string | null) {
  return state.event_log
    .filter((event) => {
      if (event.visibility === "public") return true;
      if (!viewerPlayerId) return false;
      if (event.visibility === "actor_only") {
        return event.actor_player_id === viewerPlayerId;
      }
      if (event.visibility === "actor_and_target") {
        return (
          event.actor_player_id === viewerPlayerId || event.target_player_id === viewerPlayerId
        );
      }
      return false;
    })
    .slice(-40)
    .map((event) => ({ ...event }));
}

function createGamePayload(room: Room, socketId: string) {
  const state = room.state;
  if (!state) {
    return null;
  }

  const roomPlayer = findRoomPlayer(room, socketId);
  const assignedPlayerId = roomPlayer?.player_id ?? null;
  const viewerPlayerId =
    assignedPlayerId && state.players.some((player) => player.id === assignedPlayerId)
      ? assignedPlayerId
      : null;
  const privateStatus = viewerPlayerId
    ? getPlayerPrivateStatus(state, viewerPlayerId)
    : null;

  const legalActions = viewerPlayerId ? getLegalActions(state, viewerPlayerId) : [];
  const flipCardInstanceIds = legalActions
    .filter((action) => action.type === "flip_card" && action.card_instance_id)
    .map((action) => action.card_instance_id as string);

  const pendingChoice =
    state.pending_choice && viewerPlayerId === state.pending_choice.player_id
      ? {
          choice_id: state.pending_choice.choice_id,
          kind: state.pending_choice.kind,
          options: createLabeledOptions(state, room, state.pending_choice),
        }
      : null;

  const pendingReaction =
    state.pending_reaction && viewerPlayerId === state.pending_reaction.player_id
      ? {
          card_name: state.pending_reaction.card_name,
          card_id: state.pending_reaction.card_id,
          options: state.pending_reaction.options.map((option) => ({ ...option })),
        }
      : null;

  return {
    room_id: room.id,
    status: room.status,
    you: {
      socket_id: socketId,
      player_id: viewerPlayerId,
      display_name: roomPlayer?.display_name ?? "旁观者",
      is_host: socketId === room.host_socket_id,
      private_status: privateStatus,
    },
    game: {
      phase: state.phase,
      turn_number: state.turn_number,
      current_player_id: state.players[state.current_player_index]?.id ?? null,
      current_player_name: state.players[state.current_player_index]?.name ?? null,
      winner: state.winner,
      players: state.players.map((player) => ({
        id: player.id,
        name: player.name,
        alive: player.alive,
        role: viewerPlayerId === player.id ? player.role : "hidden",
        front_face_down_count: player.front_face_down_cards.length,
        key_count: player.front_face_down_cards.filter(
          (card) => card.card_id === "silver_key" || card.card_id === "killer_key",
        ).length,
        front_face_down_cards: [],
        front_face_up_cards: player.front_face_up_cards.map((card) => ({
          instance_id: card.instance_id,
          card_id: card.card_id,
          name: card.name,
        })),
      })),
      board_slots: state.board_slots.map((instanceId, index) => {
        if (!instanceId) {
          return {
            slot_index: index + 1,
            occupied: false,
            instance_id: null,
            face_up: false,
            card_id: null,
            name: "空位",
          };
        }

        const card = state.board_face_down_cards.find((item) => item.instance_id === instanceId);
        if (!card) {
          return {
            slot_index: index + 1,
            occupied: false,
            instance_id: null,
            face_up: false,
            card_id: null,
            name: "空位",
          };
        }

        return {
          slot_index: index + 1,
          occupied: true,
          instance_id: card.instance_id,
          face_up: card.face_up,
          card_id: "unknown",
          name: "未知房间",
        };
      }),
      removed_count: state.removed_from_game.length,
      pending_reaction: pendingReaction,
      pending_choice: pendingChoice,
      legal_actions: {
        flip_card_instance_ids: flipCardInstanceIds,
      },
      events: createEventView(state, viewerPlayerId),
    },
  };
}

function createLobbyPayload(room: Room, socketId: string) {
  const roomPlayer = findRoomPlayer(room, socketId);
  return {
    room_id: room.id,
    status: room.status,
    you: {
      socket_id: socketId,
      display_name: roomPlayer?.display_name ?? "未知",
      is_host: socketId === room.host_socket_id,
    },
    lobby: {
      host_socket_id: room.host_socket_id,
      players: room.players.map((player) => ({
        socket_id: player.socket_id,
        display_name: player.display_name,
        ready: player.ready,
      })),
    },
  };
}

function emitRoomUpdate(io: Server, room: Room): void {
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.socket_id);
    if (!socket) continue;

    if (room.status === "lobby") {
      socket.emit("lobby_update", createLobbyPayload(room, player.socket_id));
    } else {
      socket.emit("game_update", createGamePayload(room, player.socket_id));
    }
  }
}

function removeSocketFromRoom(io: Server, socket: Socket): void {
  const room = findRoomBySocket(socket.id);
  if (!room) return;

  socketRoomMap.delete(socket.id);
  const leavingPlayer = findRoomPlayer(room, socket.id);
  room.players = room.players.filter((player) => player.socket_id !== socket.id);

  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }

  if (room.status === "lobby") {
    if (room.host_socket_id === socket.id) {
      room.host_socket_id = room.players[0].socket_id;
    }
    emitRoomUpdate(io, room);
    return;
  }

  for (const remaining of room.players) {
    const remainingSocket = io.sockets.sockets.get(remaining.socket_id);
    if (remainingSocket) {
      remainingSocket.emit(
        "room_error",
        `${leavingPlayer?.display_name ?? "有玩家"} 断开连接，本局已结束。`,
      );
    }
    socketRoomMap.delete(remaining.socket_id);
  }

  rooms.delete(room.id);
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/" || url.startsWith("/?")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === "/runtime-config.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(runtimeConfigJs);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
  },
});

io.on("connection", (socket) => {
  socket.emit("system_message", "已连接服务器");

  socket.on("create_room", (payload: { player_name?: string }) => {
    try {
      const playerName = normalizeName(payload?.player_name);
      if (!playerName) {
        socket.emit("room_error", "玩家名不能为空");
        return;
      }

      removeSocketFromRoom(io, socket);

      const roomId = createRoomId();
      const room: Room = {
        id: roomId,
        host_socket_id: socket.id,
        status: "lobby",
        players: [
          {
            socket_id: socket.id,
            display_name: playerName,
            ready: true,
            player_id: null,
          },
        ],
        state: null,
      };

      rooms.set(roomId, room);
      socketRoomMap.set(socket.id, roomId);
      socket.join(roomId);
      emitRoomUpdate(io, room);
    } catch (error) {
      socket.emit("room_error", String(error));
    }
  });

  socket.on("join_room", (payload: { room_id?: string; player_name?: string }) => {
    try {
      const roomId = String(payload?.room_id ?? "").trim().toUpperCase();
      const playerName = normalizeName(payload?.player_name);

      if (!roomId || !playerName) {
        socket.emit("room_error", "房间号和玩家名都不能为空");
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        socket.emit("room_error", "房间不存在");
        return;
      }
      if (room.status !== "lobby") {
        socket.emit("room_error", "对局已开始，无法加入");
        return;
      }
      if (room.players.length >= rules.player_count.max) {
        socket.emit("room_error", "房间人数已满");
        return;
      }

      removeSocketFromRoom(io, socket);

      room.players.push({
        socket_id: socket.id,
        display_name: playerName,
        ready: false,
        player_id: null,
      });

      socketRoomMap.set(socket.id, room.id);
      socket.join(room.id);
      emitRoomUpdate(io, room);
    } catch (error) {
      socket.emit("room_error", String(error));
    }
  });

  socket.on("set_ready", (payload: { ready?: boolean }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.status !== "lobby") return;

    const roomPlayer = findRoomPlayer(room, socket.id);
    if (!roomPlayer) return;

    roomPlayer.ready = Boolean(payload?.ready);
    emitRoomUpdate(io, room);
  });

  socket.on("start_game", () => {
    try {
      const room = findRoomBySocket(socket.id);
      if (!room) {
        socket.emit("room_error", "你尚未加入房间");
        return;
      }
      if (room.status !== "lobby") {
        socket.emit("room_error", "当前不在大厅阶段");
        return;
      }
      if (room.host_socket_id !== socket.id) {
        socket.emit("room_error", "只有房主可以开始游戏");
        return;
      }
      if (room.players.length < rules.player_count.min) {
        socket.emit("room_error", `至少需要 ${rules.player_count.min} 名玩家`);
        return;
      }
      if (!room.players.every((player) => player.ready)) {
        socket.emit("room_error", "有玩家未准备");
        return;
      }

      room.state = createInitialGameState(
        room.players.map((player) => player.display_name),
        rules,
      );
      room.status = "playing";

      room.players.forEach((player, index) => {
        player.player_id = room.state?.players[index]?.id ?? null;
      });

      emitRoomUpdate(io, room);
    } catch (error) {
      socket.emit("room_error", String(error));
    }
  });

  socket.on("restart_game", () => {
    try {
      const room = findRoomBySocket(socket.id);
      if (!room) {
        socket.emit("room_error", "你尚未加入房间");
        return;
      }
      if (room.host_socket_id !== socket.id) {
        socket.emit("room_error", "只有房主可以重开游戏");
        return;
      }
      if (room.status !== "ended") {
        socket.emit("room_error", "当前不在可重开状态");
        return;
      }

      room.status = "lobby";
      room.state = null;
      room.players = room.players.map((player) => ({
        ...player,
        ready: player.socket_id === room.host_socket_id,
        player_id: null,
      }));

      emitRoomUpdate(io, room);
    } catch (error) {
      socket.emit("room_error", String(error));
    }
  });

  socket.on("game_flip", (payload: { card_instance_id?: string }) => {
    try {
      const room = findRoomBySocket(socket.id);
      if (!room || !isRoomPlayable(room) || !room.state) {
        socket.emit("room_error", "当前没有可进行的对局");
        return;
      }

      const roomPlayer = findRoomPlayer(room, socket.id);
      const actingPlayerId =
        roomPlayer?.player_id &&
        room.state.players.some((player) => player.id === roomPlayer.player_id)
          ? roomPlayer.player_id
          : null;
      if (!actingPlayerId) {
        emitRoomUpdate(io, room);
        return;
      }

      const cardInstanceId = String(payload?.card_instance_id ?? "").trim();
      if (!cardInstanceId) {
        socket.emit("room_error", "缺少 card_instance_id");
        return;
      }

      room.state = flipCard(room.state, actingPlayerId, cardInstanceId);
      if (room.state.phase === "ended") {
        room.status = "ended";
      }
      emitRoomUpdate(io, room);
    } catch (error) {
      socket.emit("room_error", String(error));
    }
  });

  socket.on("game_choice", (payload: ResolveChoiceInput) => {
    try {
      const room = findRoomBySocket(socket.id);
      if (!room || !isRoomPlayable(room) || !room.state) {
        socket.emit("room_error", "当前没有可进行的对局");
        return;
      }

      const roomPlayer = findRoomPlayer(room, socket.id);
      const actingPlayerId =
        roomPlayer?.player_id &&
        room.state.players.some((player) => player.id === roomPlayer.player_id)
          ? roomPlayer.player_id
          : null;
      if (!actingPlayerId) {
        emitRoomUpdate(io, room);
        return;
      }

      if (
        !room.state.pending_choice ||
        room.state.pending_choice.player_id !== actingPlayerId
      ) {
        emitRoomUpdate(io, room);
        return;
      }

      room.state = resolvePendingChoice(room.state, actingPlayerId, payload);
      if (room.state.phase === "ended") {
        room.status = "ended";
      }
      emitRoomUpdate(io, room);
    } catch (error) {
      socket.emit("room_error", String(error));
    }
  });

  socket.on("game_reaction", (payload: { reaction_id?: string }) => {
    try {
      const room = findRoomBySocket(socket.id);
      if (!room || !isRoomPlayable(room) || !room.state) {
        socket.emit("room_error", "当前没有可进行的对局");
        return;
      }

      const roomPlayer = findRoomPlayer(room, socket.id);
      const actingPlayerId =
        roomPlayer?.player_id &&
        room.state.players.some((player) => player.id === roomPlayer.player_id)
          ? roomPlayer.player_id
          : null;
      if (!actingPlayerId) {
        emitRoomUpdate(io, room);
        return;
      }

      if (
        !room.state.pending_reaction ||
        room.state.pending_reaction.player_id !== actingPlayerId
      ) {
        emitRoomUpdate(io, room);
        return;
      }

      const reactionId = String(payload?.reaction_id ?? "").trim();
      if (!reactionId) {
        socket.emit("room_error", "缺少 reaction_id");
        return;
      }

      room.state = resolvePendingReaction(room.state, actingPlayerId, {
        reaction_id: reactionId,
      });
      if (room.state.phase === "ended") {
        room.status = "ended";
      }
      emitRoomUpdate(io, room);
    } catch (error) {
      socket.emit("room_error", String(error));
    }
  });

  socket.on("request_update", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    if (room.status === "lobby") {
      socket.emit("lobby_update", createLobbyPayload(room, socket.id));
      return;
    }
    socket.emit("game_update", createGamePayload(room, socket.id));
  });

  socket.on("leave_room", () => {
    removeSocketFromRoom(io, socket);
  });

  socket.on("disconnect", () => {
    removeSocketFromRoom(io, socket);
  });
});

server.listen(PORT, () => {
  console.log(`Web game server started: http://localhost:${PORT}`);
  console.log(
    `Socket.IO CORS origin: ${Array.isArray(corsOrigin) ? corsOrigin.join(", ") : corsOrigin}`,
  );
});
