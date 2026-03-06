import { EventLogEntry, GameState } from "./models.js";

export type EventInput = Omit<EventLogEntry, "at_turn" | "at_seq">;

export function emitEvent(state: GameState, event: EventInput): void {
  state.event_log.push({
    ...event,
    at_turn: state.turn_number,
    at_seq: state.event_log.length + 1,
  });
}

export function playerLabel(state: GameState, playerId: string | undefined): string {
  if (!playerId) return "未知玩家";
  const player = state.players.find((item) => item.id === playerId);
  return player ? player.name : playerId;
}
