import { getPlayerById } from "./derivedQueries.js";
import { GameState, PlayerRole } from "./models.js";

export interface PlayerPrivateStatus {
  player_id: string;
  role: PlayerRole;
  is_killer: boolean;
  alive: boolean;
}

export function getPlayerPrivateStatus(
  state: GameState,
  viewerPlayerId: string,
): PlayerPrivateStatus {
  const player = getPlayerById(state, viewerPlayerId);
  if (!player) {
    throw new Error(`Player not found: ${viewerPlayerId}`);
  }

  return {
    player_id: player.id,
    role: player.role,
    is_killer: player.role === "killer",
    alive: player.alive,
  };
}

export function serializeStateForPlayer(
  state: GameState,
  viewerPlayerId: string,
): string {
  const player = getPlayerById(state, viewerPlayerId);
  if (!player) {
    throw new Error(`Player not found: ${viewerPlayerId}`);
  }

  const { shuffle_fn, ...serializable } = state;
  const masked = {
    ...serializable,
    players: serializable.players.map((p) => ({
      ...p,
      role: p.id === viewerPlayerId ? p.role : "hidden",
    })),
    pending_reaction:
      serializable.pending_reaction?.player_id === viewerPlayerId
        ? {
            ...serializable.pending_reaction,
            options: serializable.pending_reaction.options.map((option) => ({ ...option })),
          }
        : null,
    event_log: serializable.event_log.filter((event) => {
      if (event.visibility === "public") return true;
      if (event.visibility === "actor_only") return event.actor_player_id === viewerPlayerId;
      if (event.visibility === "actor_and_target") {
        return (
          event.actor_player_id === viewerPlayerId ||
          event.target_player_id === viewerPlayerId
        );
      }
      return false;
    }),
  };

  return JSON.stringify(masked, null, 2);
}
