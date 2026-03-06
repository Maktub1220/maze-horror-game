import {
  EffectContext,
  GameState,
  WinnerInfo,
} from "./models.js";
import {
  aliveKillers,
  allNonKillerPlayers,
  onlyKillersAlive,
  playerHasCard,
  revealedKeysAllReal,
  teamTotalKeys,
} from "./derivedQueries.js";

export function evaluateCheck(
  state: GameState,
  context: EffectContext,
  checkId: string,
  value: unknown,
): boolean {
  switch (checkId) {
    case "team_total_keys_at_least":
      return teamTotalKeys(state) >= Number(value);

    case "player_role_is": {
      const player = state.players.find((p) => p.id === context.current_player_id);
      return !!player && player.role === value;
    }

    case "player_has_card":
      return playerHasCard(state, context.current_player_id, String(value));

    case "revealed_keys_all_real":
      return revealedKeysAllReal(state, context.chosen_key_instance_ids ?? []);

    case "only_killers_alive":
      return onlyKillersAlive(state);

    default:
      return false;
  }
}

export function resolveWinnerTarget(state: GameState, target: string): WinnerInfo {
  switch (target) {
    case "all_non_killer_players":
      return {
        team: "non_killers",
        player_ids: allNonKillerPlayers(state).map((player) => player.id),
      };

    case "all_killers":
      return {
        team: "killer",
        player_ids: state.players
          .filter((player) => player.role === "killer")
          .map((player) => player.id),
      };

    case "all_alive_killers":
      return {
        team: "killer",
        player_ids: aliveKillers(state).map((player) => player.id),
      };

    default:
      throw new Error(`Unsupported winner target: ${target}`);
  }
}

export function checkWinConditions(state: GameState): GameState {
  if (state.phase === "ended" || state.winner) {
    return state;
  }

  const killerLastAliveCondition = state.rules_package.rules.win_conditions.find(
    (condition) => condition.trigger === "only_killers_alive",
  );

  if (killerLastAliveCondition && onlyKillersAlive(state)) {
    const winner = resolveWinnerTarget(state, killerLastAliveCondition.winner_target);
    return {
      ...state,
      phase: "ended",
      winner,
      event_log: [...state.event_log, { type: "winner", value: winner.team }],
    };
  }

  return state;
}
