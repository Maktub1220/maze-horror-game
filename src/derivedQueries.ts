import { CardDefinition, CardInstance, GameState, Player } from "./models.js";

export function alivePlayers(state: GameState): Player[] {
  return state.players.filter((player) => player.alive);
}

export function aliveKillers(state: GameState): Player[] {
  return alivePlayers(state).filter((player) => player.role === "killer");
}

export function allNonKillerPlayers(state: GameState): Player[] {
  return state.players.filter((player) => player.role !== "killer" && player.alive);
}

export function teamTotalKeys(state: GameState): number {
  return alivePlayers(state).reduce((total, player) => {
    const keys = player.front_face_down_cards.filter((card) =>
      isKeyCard(state, card.card_id),
    );
    return total + keys.length;
  }, 0);
}

export function playerHasCard(
  state: GameState,
  playerId: string,
  cardId: string,
): boolean {
  const player = getPlayerById(state, playerId);
  if (!player) return false;

  return [...player.front_face_down_cards, ...player.front_face_up_cards].some(
    (card) => card.card_id === cardId,
  );
}

export function playerHasFaceDownKey(state: GameState, playerId: string): boolean {
  const player = getPlayerById(state, playerId);
  if (!player) return false;

  return player.front_face_down_cards.some((card) => isKeyCard(state, card.card_id));
}

export function revealedKeysAllReal(state: GameState, keyInstanceIds: string[]): boolean {
  if (keyInstanceIds.length !== 3) {
    return false;
  }

  return keyInstanceIds.every((instanceId) => {
    const card = findCardInstanceAnywhere(state, instanceId);
    return !!card && card.card_id === "silver_key";
  });
}

export function onlyKillersAlive(state: GameState): boolean {
  const alive = alivePlayers(state);
  if (alive.length === 0) return false;

  return alive.length === 1 && alive[0].role === "killer";
}

export function getPlayerById(state: GameState, playerId: string): Player | undefined {
  return state.players.find((player) => player.id === playerId);
}

export function getCurrentPlayer(state: GameState): Player | undefined {
  return state.players[state.current_player_index];
}

export function getCardDefinition(state: GameState, cardId: string): CardDefinition {
  const definition = state.rules_package.cards.find((card) => card.id === cardId);
  if (!definition) {
    throw new Error(`Card definition not found: ${cardId}`);
  }
  return definition;
}

export function getCardByInstanceId(
  state: GameState,
  instanceId: string,
): CardInstance | undefined {
  return state.board_face_down_cards.find((card) => card.instance_id === instanceId);
}

export function findCardInstanceAnywhere(
  state: GameState,
  instanceId: string,
): CardInstance | undefined {
  const boardCard = state.board_face_down_cards.find((card) => card.instance_id === instanceId);
  if (boardCard) return boardCard;

  for (const player of state.players) {
    const fromDown = player.front_face_down_cards.find((card) => card.instance_id === instanceId);
    if (fromDown) return fromDown;

    const fromUp = player.front_face_up_cards.find((card) => card.instance_id === instanceId);
    if (fromUp) return fromUp;
  }

  return state.removed_from_game.find((card) => card.instance_id === instanceId);
}

export function isKeyCard(state: GameState, cardId: string): boolean {
  const definition = getCardDefinition(state, cardId);
  return definition.tags.includes("key");
}

export function isRealKey(cardId: string): boolean {
  return cardId === "silver_key";
}
