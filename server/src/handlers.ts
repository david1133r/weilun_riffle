import type { Server, Socket } from 'socket.io';
import {
  DISCONNECT_GRACE_MS,
  HOLDEM_SHOWDOWN_MS,
  HOLDEM_START_CHIPS,
  MAHJONG_ACTION_KINDS,
  MONOPOLY_ACTION_KINDS,
  MONOPOLY_ESTATE_IDS,
  SEAT_LIMITS,
  TURN_MS,
  type Ack,
  type BetAction,
  type Card,
  type ChatMessage,
  type ClientToServerEvents,
  type JoinMode,
  type MahjongAction,
  type MahjongReactionAction,
  type MahjongRoundResult,
  type MahjongSelfDrawAction,
  type MahjongTileId,
  type MonopolyAction,
  type MonopolyEstateId,
  type PlayerId,
  type ServerToClientEvents,
  type SystemNotice,
} from 'shared';
import {
  PLAY_ERROR_MESSAGE,
  autoAct,
  dealGame,
  passTurn,
  playCards,
  removePlayerFromGame,
} from './gameEngine.js';
import {
  BET_ERROR_MESSAGE,
  applyBet,
  autoActHoldem,
  nextButtonSeat,
  removePlayerFromHoldem,
  startHand,
  type HoldemState,
} from './holdemEngine.js';
import { aiChooseDiscard, aiRespond, aiSelfDrawAction } from './mahjongAi.js';
import {
  MAHJONG_ERROR_MESSAGE,
  allMahjongRoundReady,
  autoActMahjong,
  chooseSelfDrawAction,
  confirmMahjongRoundReady,
  continueMahjongRound,
  discardTile,
  rankMahjongSeats,
  respondToReaction,
  startMahjong,
  type MahjongError,
  type MahjongState,
} from './mahjongEngine.js';
import {
  MONOPOLY_ERROR_MESSAGE,
  applyMonopolyAction,
  autoActMonopoly,
  removePlayerFromMonopoly,
  startMonopoly,
  type MonopolyEvent,
} from './monopolyEngine.js';
import {
  addSpectator,
  buildRoomView,
  buildSummary,
  canStart,
  clampMaxPlayers,
  createRoom,
  fillMahjongNpcSeats,
  fundedCount,
  generateRoomId,
  isEmpty,
  makeChatMessage,
  makeSystemMessage,
  memberOf,
  modeOf,
  monopolyLogOf,
  nicknameOf,
  normalizeBigTwoRules,
  normalizeGameType,
  normalizeMonopolyOptions,
  pushChat,
  pushLog,
  refillChips,
  removeMember,
  seatPlayer,
  seatedPlayers,
  statusOf,
  type Member,
  type Room,
} from './rooms.js';
import { assertNeverGame } from './turnBased.js';

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type GameIo = Server<ClientToServerEvents, ServerToClientEvents>;

const LOBBY = 'lobby';
const roomChannel = (roomId: string) => `room:${roomId}`;

/** 斷線的人輪到時不用等滿 45 秒，短暫等一下就代打。 */
const DISCONNECTED_TURN_MS = 3_000;

/** 台灣麻將一局結束後，等大家在結算畫面按繼續；超過這個時間還沒按的真人直接踢出去換電腦代打。 */
const MAHJONG_ROUND_READY_MS = 20_000;

/** 電腦座位出手前的固定延遲。真人的思考時間在 mahjongEngine.ts 另外給 1 分鐘。 */
const MAHJONG_NPC_DELAY_MS = 1_800;

const BET_ACTIONS: readonly BetAction[] = ['fold', 'check', 'call', 'raise', 'allin'];

interface Session {
  playerId: PlayerId;
  nickname: string;
  roomId: string | null;
}

/** 戰報只送牌的 id，文字寫法交給前端的外觀決定。 */
function cardIdsOf(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id);
}

function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanNumber(input: unknown): number {
  const n = Math.floor(Number(input));
  return Number.isFinite(n) ? n : 0;
}

function cleanEstateId(input: unknown): MonopolyEstateId | null {
  return MONOPOLY_ESTATE_IDS.find((id) => id === input) ?? null;
}

function cleanEstateIds(input: unknown): MonopolyEstateId[] | null {
  if (!Array.isArray(input)) return null;
  const ids: MonopolyEstateId[] = [];
  for (const raw of input) {
    const id = cleanEstateId(raw);
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * 把來路不明的 payload 收成 MonopolyAction。
 * 認不得的 kind、缺欄位、格子代號不存在 —— 一律回 null，由呼叫端吐 BAD_ACTION。
 */
function parseMonopolyAction(value: unknown): MonopolyAction | null {
  const input = (value ?? {}) as { kind?: unknown };
  const kind = MONOPOLY_ACTION_KINDS.find((k) => k === input.kind);
  if (!kind) return null;

  switch (kind) {
    case 'roll':
    case 'buy':
    case 'decline':
    case 'passBid':
    case 'payBail':
    case 'useJailCard':
    case 'rollForDoubles':
    case 'declareBankrupt':
    case 'endTurn':
      return { kind };

    case 'bid':
      return { kind, amount: cleanNumber((input as { amount?: unknown }).amount) };

    case 'build':
    case 'sellHouse':
    case 'mortgage':
    case 'unmortgage': {
      const tile = cleanEstateId((input as { tile?: unknown }).tile);
      return tile ? { kind, tile } : null;
    }

    case 'respondTrade':
      return { kind, accept: (input as { accept?: unknown }).accept === true };

    case 'offerTrade': {
      const raw = input as {
        to?: unknown;
        give?: unknown;
        want?: unknown;
        giveCash?: unknown;
        wantCash?: unknown;
      };
      const to = cleanText(raw.to, 64);
      const give = cleanEstateIds(raw.give);
      const want = cleanEstateIds(raw.want);
      if (!to || !give || !want) return null;
      return {
        kind,
        to,
        give,
        want,
        giveCash: cleanNumber(raw.giveCash),
        wantCash: cleanNumber(raw.wantCash),
      };
    }
  }
}

/**
 * 把來路不明的 payload 收成 MahjongAction。
 * 認不得的 kind、缺欄位 —— 一律回 null，由呼叫端吐 BAD_ACTION。
 */
function parseMahjongAction(value: unknown): MahjongAction | null {
  const input = (value ?? {}) as { kind?: unknown };
  const kind = MAHJONG_ACTION_KINDS.find((k) => k === input.kind);
  if (!kind) return null;

  switch (kind) {
    case 'discard': {
      const tile = (input as { tile?: unknown }).tile;
      return typeof tile === 'string' && tile ? { kind, tile } : null;
    }
    case 'selfDraw': {
      const raw = input as { action?: unknown; tile?: unknown };
      const action = raw.action as MahjongSelfDrawAction;
      if (action !== 'hu' && action !== 'gang' && action !== 'none') return null;
      const tile = typeof raw.tile === 'string' ? raw.tile : undefined;
      return { kind, action, tile };
    }
    case 'respond': {
      const raw = input as { action?: unknown; chiTiles?: unknown };
      const action = raw.action as MahjongReactionAction;
      if (action !== 'hu' && action !== 'peng' && action !== 'gang' && action !== 'chi' && action !== 'pass') {
        return null;
      }
      let chiTiles: [MahjongTileId, MahjongTileId] | undefined;
      const rawChi = raw.chiTiles;
      if (Array.isArray(rawChi) && rawChi.length === 2 && typeof rawChi[0] === 'string' && typeof rawChi[1] === 'string') {
        chiTiles = [rawChi[0], rawChi[1]];
      }
      return { kind, action, chiTiles };
    }
    case 'continueRound':
      return { kind };
  }
}

function reply<T>(ack: unknown, payload: Parameters<Ack<T>>[0]): void {
  if (typeof ack === 'function') (ack as Ack<T>)(payload);
}

export class GameServer {
  private readonly rooms = new Map<string, Room>();
  private readonly lobbyChat: ChatMessage[] = [];
  /** socket.id → session */
  private readonly sessions = new Map<string, Session>();
  /** playerId → 目前所在房間，斷線寬限期內也保留著，才能無縫接回。 */
  private readonly playerRoom = new Map<PlayerId, string>();
  /** 德州撲克：已經寫過戰報的手數，避免同一手被重複結算播報。 */
  private readonly loggedHand = new Map<string, number>();

  constructor(private readonly io: GameIo) {
    io.on('connection', (socket) => this.register(socket));
  }

  // -------------------------------------------------------------------------
  // 事件註冊
  // -------------------------------------------------------------------------

  private register(socket: GameSocket): void {
    socket.on('session:hello', (payload, ack) => this.onHello(socket, payload, ack));
    socket.on('lobby:chat', (payload) => this.onLobbyChat(socket, payload));
    socket.on('room:create', (payload, ack) => this.onCreateRoom(socket, payload, ack));
    socket.on('room:join', (payload, ack) => this.onJoinRoom(socket, payload, ack));
    socket.on('room:leave', (_payload, ack) => this.onLeaveRoom(socket, ack));
    socket.on('room:chat', (payload) => this.onRoomChat(socket, payload));
    socket.on('room:ready', (payload) => this.onReady(socket, payload));
    socket.on('game:start', (_payload, ack) => this.onStartGame(socket, ack));
    socket.on('game:play', (payload, ack) => this.onPlay(socket, payload, ack));
    socket.on('game:pass', (_payload, ack) => this.onPass(socket, ack));
    socket.on('game:action', (payload, ack) => this.onAction(socket, payload, ack));
    socket.on('game:monopoly', (payload, ack) => this.onMonopoly(socket, payload, ack));
    socket.on('game:mahjong', (payload, ack) => this.onMahjong(socket, payload, ack));
    socket.on('room:addNpc', (_payload, ack) => this.onAddNpc(socket, ack));
    socket.on('room:requestJoin', (payload, ack) => this.onMahjongRequestJoin(socket, payload, ack));
    socket.on('room:respondJoinRequest', (payload, ack) => this.onMahjongRespondJoinRequest(socket, payload, ack));
    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  // -------------------------------------------------------------------------
  // 連線 / 重連
  // -------------------------------------------------------------------------

  private onHello(
    socket: GameSocket,
    payload: { playerId?: unknown; nickname?: unknown },
    ack: unknown,
  ): void {
    const playerId = cleanText(payload?.playerId, 64);
    const nickname = cleanText(payload?.nickname, 12) || '玩家';

    if (!playerId) {
      reply(ack, { ok: false, error: { code: 'BAD_SESSION', message: '缺少玩家識別碼' } });
      return;
    }

    // 同一個 playerId 從別的分頁連進來，踢掉舊連線避免兩邊互搶
    for (const [oldSocketId, session] of this.sessions) {
      if (session.playerId === playerId && oldSocketId !== socket.id) {
        this.sessions.delete(oldSocketId);
        this.io.sockets.sockets.get(oldSocketId)?.disconnect(true);
      }
    }

    const roomId = this.playerRoom.get(playerId) ?? null;
    const room = roomId ? this.rooms.get(roomId) : undefined;

    this.sessions.set(socket.id, { playerId, nickname, roomId: room ? room.id : null });

    if (room) {
      this.reattach(socket, room, playerId, nickname);
      reply(ack, { ok: true, data: { roomId: room.id } });
      return;
    }

    this.playerRoom.delete(playerId);
    this.enterLobby(socket);
    reply(ack, { ok: true, data: { roomId: null } });
  }

  /** 斷線重連：接回原本的座位與手牌。 */
  private reattach(socket: GameSocket, room: Room, playerId: PlayerId, nickname: string): void {
    const member = memberOf(room, playerId);
    if (!member) {
      // 寬限期已過被清掉了，退回大廳
      this.playerRoom.delete(playerId);
      const session = this.sessions.get(socket.id);
      if (session) session.roomId = null;
      this.enterLobby(socket);
      return;
    }

    if (member.graceTimer) {
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
    }
    member.socketId = socket.id;
    member.connected = true;
    member.nickname = nickname;

    socket.leave(LOBBY);
    socket.join(roomChannel(room.id));

    // 斷線時把回合縮短成 3 秒，回來了要把整個回合還給他，否則一重整就被自動代打
    const game = room.game;
    if (game && !game.state.over && room.seats[game.state.turnSeat] === playerId) {
      game.state.turnDeadline = Date.now() + TURN_MS;
    }

    socket.emit('room:chat', { messages: room.chat });
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.scheduleTurn(room);
  }

  private enterLobby(socket: GameSocket): void {
    socket.join(LOBBY);
    socket.emit('room:state', null);
    socket.emit('lobby:chat', { messages: this.lobbyChat });
    socket.emit('lobby:state', { rooms: this.lobbySnapshot() });
  }

  private onDisconnect(socket: GameSocket): void {
    const session = this.sessions.get(socket.id);
    this.sessions.delete(socket.id);
    if (!session?.roomId) return;

    const room = this.rooms.get(session.roomId);
    if (!room) return;

    const member = memberOf(room, session.playerId);
    if (!member || member.socketId !== socket.id) return; // 已經被新連線接手

    member.connected = false;
    member.socketId = null;
    member.graceTimer = setTimeout(() => {
      member.graceTimer = null;
      this.dropFromRoom(room, session.playerId, 'disconnected');
    }, DISCONNECT_GRACE_MS);

    this.broadcastRoom(room);
    this.scheduleTurn(room); // 換成短計時，避免整桌等他 45 秒
  }

  // -------------------------------------------------------------------------
  // 大廳
  // -------------------------------------------------------------------------

  private lobbySnapshot() {
    return [...this.rooms.values()].map(buildSummary);
  }

  private broadcastLobby(): void {
    this.io.to(LOBBY).emit('lobby:state', { rooms: this.lobbySnapshot() });
  }

  private onLobbyChat(socket: GameSocket, payload: { text?: unknown }): void {
    const session = this.sessions.get(socket.id);
    if (!session || session.roomId) return; // 房間內的人講話走 room:chat
    const text = cleanText(payload?.text, 200);
    if (!text) return;

    pushChat(this.lobbyChat, makeChatMessage(session.nickname, text, session.playerId));
    this.io.to(LOBBY).emit('lobby:chat', { messages: this.lobbyChat });
  }

  // -------------------------------------------------------------------------
  // 房間
  // -------------------------------------------------------------------------

  private broadcastRoom(room: Room): void {
    for (const member of [...room.players.values(), ...room.spectators.values()]) {
      if (!member.socketId) continue;
      const socket = this.io.sockets.sockets.get(member.socketId);
      socket?.emit('room:state', buildRoomView(room, member.playerId));
    }
  }

  private broadcastRoomChat(room: Room): void {
    this.io.to(roomChannel(room.id)).emit('room:chat', { messages: room.chat });
  }

  private systemNotice(room: Room, notice: SystemNotice): void {
    pushChat(room.chat, makeSystemMessage(notice));
    this.broadcastRoomChat(room);
  }

  private memberFromSession(session: Session): Member {
    return {
      playerId: session.playerId,
      nickname: session.nickname,
      socketId: null,
      connected: true,
      graceTimer: null,
    };
  }

  private onCreateRoom(
    socket: GameSocket,
    payload: {
      name?: unknown;
      maxPlayers?: unknown;
      gameType?: unknown;
      bigTwoRules?: unknown;
      monopolyOptions?: unknown;
    },
    ack: unknown,
  ): void {
    const session = this.sessions.get(socket.id);
    if (!session) return reply(ack, { ok: false, error: { code: 'BAD_SESSION', message: '請先連線' } });
    if (session.roomId) {
      return reply(ack, { ok: false, error: { code: 'ALREADY_IN_ROOM', message: '你已經在房間裡' } });
    }

    const name = cleanText(payload?.name, 20) || `${session.nickname} 的房間`;
    const gameType = normalizeGameType(payload?.gameType);
    const maxPlayers = clampMaxPlayers(payload?.maxPlayers, gameType);
    const bigTwoRules = normalizeBigTwoRules(payload?.bigTwoRules);
    const monopolyOptions = normalizeMonopolyOptions(payload?.monopolyOptions);
    const id = generateRoomId((candidate) => this.rooms.has(candidate));

    const host = this.memberFromSession(session);
    host.socketId = socket.id;
    const room = createRoom({
      id,
      name,
      gameType,
      maxPlayers,
      bigTwoRules,
      monopolyOptions,
      host,
    });
    this.rooms.set(id, room);

    session.roomId = id;
    this.playerRoom.set(session.playerId, id);
    socket.leave(LOBBY);
    socket.join(roomChannel(id));

    this.systemNotice(room, { t: 'created', player: session.nickname });
    this.broadcastRoom(room);
    this.broadcastLobby();
    reply(ack, { ok: true, data: { roomId: id } });
  }

  private onJoinRoom(
    socket: GameSocket,
    payload: { roomId?: unknown; mode?: unknown },
    ack: unknown,
  ): void {
    const session = this.sessions.get(socket.id);
    if (!session) return reply(ack, { ok: false, error: { code: 'BAD_SESSION', message: '請先連線' } });

    const roomId = cleanText(payload?.roomId, 16).toUpperCase();
    const mode: JoinMode = payload?.mode === 'spectate' ? 'spectate' : 'play';
    const room = this.rooms.get(roomId);
    if (!room) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '找不到這個房間' } });

    // 已經在別的房間就先退出
    if (session.roomId && session.roomId !== roomId) this.leaveCurrentRoom(socket, session);

    const currentMode = modeOf(room, session.playerId);
    if (currentMode === mode) return reply(ack, { ok: true, data: { roomId } });

    if (mode === 'play') {
      if (statusOf(room) === 'playing') {
        return reply(ack, {
          ok: false,
          error: { code: 'IN_PROGRESS', message: '這局已經開打了，可以先觀戰' },
        });
      }
      if (room.seats.every((seat) => seat !== null)) {
        return reply(ack, { ok: false, error: { code: 'ROOM_FULL', message: '房間已滿，可以先觀戰' } });
      }
    }

    const member = currentMode ? memberOf(room, session.playerId)! : this.memberFromSession(session);
    member.socketId = socket.id;
    member.connected = true;
    member.nickname = session.nickname;
    if (currentMode) removeMember(room, session.playerId);

    if (mode === 'play') {
      seatPlayer(room, member);
    } else {
      // 遊戲中改當觀眾等同棄牌
      this.removeFromGame(room, session.playerId);
      addSpectator(room, member);
    }

    session.roomId = roomId;
    this.playerRoom.set(session.playerId, roomId);
    socket.leave(LOBBY);
    socket.join(roomChannel(roomId));

    socket.emit('room:chat', { messages: room.chat });
    this.systemNotice(room, {
      t: mode === 'play' ? 'joined' : 'spectating',
      player: session.nickname,
    });
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.scheduleTurn(room);
    reply(ack, { ok: true, data: { roomId } });
  }

  private onLeaveRoom(socket: GameSocket, ack: unknown): void {
    const session = this.sessions.get(socket.id);
    if (!session) return reply(ack, { ok: false, error: { code: 'BAD_SESSION', message: '請先連線' } });
    this.leaveCurrentRoom(socket, session);
    this.enterLobby(socket);
    reply(ack, { ok: true, data: null });
  }

  private leaveCurrentRoom(socket: GameSocket, session: Session): void {
    if (!session.roomId) return;
    const room = this.rooms.get(session.roomId);
    session.roomId = null;
    socket.leave(room ? roomChannel(room.id) : roomChannel(''));
    if (room) this.dropFromRoom(room, session.playerId, 'left');
  }

  /** 把玩家徹底移出房間（主動離開或斷線寬限到期）。 */
  private dropFromRoom(room: Room, playerId: PlayerId, reason: 'left' | 'disconnected'): void {
    if (!modeOf(room, playerId)) return;
    const nickname = nicknameOf(room, playerId);

    if (room.players.has(playerId)) this.removeFromGame(room, playerId);
    removeMember(room, playerId);
    this.playerRoom.delete(playerId);

    if (isEmpty(room)) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.handTimer) clearTimeout(room.handTimer);
      if (room.npcTimer) clearTimeout(room.npcTimer);
      this.rooms.delete(room.id);
      this.loggedHand.delete(room.id);
      this.broadcastLobby();
      return;
    }

    // 麻將牌局進行到一半有人離開，座位空出來後馬上補電腦代打，牌局不中斷、不判整場比賽結束。
    const game = room.game;
    if (room.gameType === 'taiwanMahjong' && game?.type === 'taiwanMahjong' && !game.state.matchOver) {
      fillMahjongNpcSeats(room);
    }

    this.systemNotice(room, { t: reason, player: nickname });
    this.afterGameAction(room);
  }

  /** 讓玩家從進行中的牌局退出：大老二是抽掉手牌，德州撲克視同蓋牌，大富翁是地產還給銀行。 */
  private removeFromGame(room: Room, playerId: PlayerId): void {
    const game = room.game;
    if (!game || game.state.over) return;
    switch (game.type) {
      case 'bigTwo':
        removePlayerFromGame(room.seats, game.state, playerId);
        return;
      case 'holdem':
        removePlayerFromHoldem(room.seats, game.state, playerId);
        return;
      case 'monopoly':
        this.logMonopoly(room, removePlayerFromMonopoly(room.seats, game.state, playerId));
        return;
      case 'taiwanMahjong':
        // 麻將座位一走，dropFromRoom 會在座位真的空出來後補電腦代打接手，牌局不中斷——
        // 不像其他玩法要在這裡動引擎狀態，麻將什麼都不用做，等電腦補位就好。
        return;
      default:
        assertNeverGame(game);
    }
  }

  /** 引擎事件換上暱稱寫進戰報。 */
  private logMonopoly(room: Room, events: readonly MonopolyEvent[]): void {
    for (const event of events) pushLog(room, monopolyLogOf(room, event));
  }

  private onRoomChat(socket: GameSocket, payload: { text?: unknown }): void {
    const session = this.sessions.get(socket.id);
    if (!session?.roomId) return;
    const room = this.rooms.get(session.roomId);
    if (!room) return;
    const text = cleanText(payload?.text, 200);
    if (!text) return;

    pushChat(room.chat, makeChatMessage(session.nickname, text, session.playerId));
    this.broadcastRoomChat(room);
  }

  private onReady(socket: GameSocket, payload: { ready?: unknown }): void {
    const session = this.sessions.get(socket.id);
    if (!session?.roomId) return;
    const room = this.rooms.get(session.roomId);
    const player = room?.players.get(session.playerId);
    if (!room || !player) return;

    player.ready = payload?.ready === true;
    this.broadcastRoom(room);
  }

  /** 房主把台灣麻將房間剩下的空位一次補滿電腦玩家，方便自己一個人也能整桌測試。 */
  private onAddNpc(socket: GameSocket, ack: unknown): void {
    const session = this.sessions.get(socket.id);
    if (!session?.roomId) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '你不在房間裡' } });
    const room = this.rooms.get(session.roomId);
    if (!room) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '找不到房間' } });
    if (room.hostId !== session.playerId) {
      return reply(ack, { ok: false, error: { code: 'NOT_HOST', message: '只有房主可以補電腦玩家' } });
    }
    if (room.gameType !== 'taiwanMahjong') {
      return reply(ack, { ok: false, error: { code: 'WRONG_GAME', message: '這個玩法不支援電腦玩家' } });
    }
    if (statusOf(room) === 'playing') {
      return reply(ack, { ok: false, error: { code: 'IN_PROGRESS', message: '這局還在進行中' } });
    }

    const added = fillMahjongNpcSeats(room);
    if (added > 0) this.systemNotice(room, { t: 'joined', player: `${added} 位電腦玩家` });
    this.broadcastRoom(room);
    this.broadcastLobby();
    reply(ack, { ok: true, data: null });
  }

  // -------------------------------------------------------------------------
  // 遊戲
  // -------------------------------------------------------------------------

  private onStartGame(socket: GameSocket, ack: unknown): void {
    const session = this.sessions.get(socket.id);
    if (!session?.roomId) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '你不在房間裡' } });
    const room = this.rooms.get(session.roomId);
    if (!room) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '找不到房間' } });

    if (room.hostId !== session.playerId) {
      return reply(ack, { ok: false, error: { code: 'NOT_HOST', message: '只有房主可以開始遊戲' } });
    }
    if (statusOf(room) === 'playing') {
      return reply(ack, { ok: false, error: { code: 'IN_PROGRESS', message: '這局還在進行中' } });
    }
    if (!canStart(room)) {
      const min = SEAT_LIMITS[room.gameType].min;
      return reply(ack, {
        ok: false,
        error: { code: 'NOT_READY', message: `需要至少 ${min} 位玩家，且所有人都按下準備` },
      });
    }

    room.log = [];
    for (const player of room.players.values()) player.ready = false;

    switch (room.gameType) {
      case 'bigTwo': {
        const state = dealGame(room.seats, room.bigTwoRules);
        room.game = { type: 'bigTwo', state };
        pushLog(room, { t: 'bigTwoStart', players: seatedPlayers(room).length });
        const leader = room.seats[state.turnSeat];
        if (leader) pushLog(room, { t: 'lead', player: nicknameOf(room, leader) });
        break;
      }
      case 'holdem':
        this.startHoldemHand(room);
        break;
      case 'monopoly': {
        const state = startMonopoly(room.seats, room.monopolyOptions);
        room.game = { type: 'monopoly', state };
        pushLog(room, {
          t: 'monopolyStart',
          players: seatedPlayers(room).length,
          startCash: room.monopolyOptions.startCash,
        });
        break;
      }
      case 'taiwanMahjong': {
        const state = startMahjong(room.seats);
        room.game = { type: 'taiwanMahjong', state };
        pushLog(room, { t: 'mahjongStart', players: seatedPlayers(room).length });
        break;
      }
      default:
        assertNeverGame(room.gameType);
    }

    this.afterGameAction(room);
    reply(ack, { ok: true, data: null });
  }

  /** 發德州撲克的下一手：補碼、轉莊、發牌、貼盲注。 */
  private startHoldemHand(room: Room): void {
    if (room.handTimer) {
      clearTimeout(room.handTimer);
      room.handTimer = null;
    }

    for (const playerId of refillChips(room)) {
      pushLog(room, {
        t: 'rebuy',
        player: nicknameOf(room, playerId),
        amount: HOLDEM_START_CHIPS,
      });
    }
    if (fundedCount(room) < SEAT_LIMITS.holdem.min) return;

    const previous = room.game?.type === 'holdem' ? room.game.state : null;
    room.buttonSeat = nextButtonSeat(room.seats, room.chips, room.buttonSeat);
    const state = startHand(room.seats, room.chips, room.buttonSeat, {
      handNo: (previous?.handNo ?? 0) + 1,
    });
    room.game = { type: 'holdem', state };

    const button = room.seats[state.buttonSeat];
    pushLog(room, {
      t: 'holdemStart',
      handNo: state.handNo,
      smallBlind: state.smallBlind,
      bigBlind: state.bigBlind,
    });
    if (button) pushLog(room, { t: 'button', player: nicknameOf(room, button) });
  }

  private onPlay(socket: GameSocket, payload: { cardIds?: unknown }, ack: unknown): void {
    const context = this.gameContext(socket, ack);
    if (!context) return;
    const { room, game, playerId } = context;
    if (game.type !== 'bigTwo') {
      return reply(ack, { ok: false, error: { code: 'WRONG_GAME', message: '這個房間玩的是德州撲克' } });
    }

    const cardIds = Array.isArray(payload?.cardIds)
      ? payload.cardIds.filter((id): id is string => typeof id === 'string')
      : [];

    const result = playCards(room.seats, game.state, playerId, cardIds);
    if (!result.ok) {
      return reply(ack, {
        ok: false,
        error: { code: result.error, message: PLAY_ERROR_MESSAGE[result.error] },
      });
    }

    pushLog(room, {
      t: 'play',
      player: nicknameOf(room, playerId),
      combo: result.result.combo.type,
      cards: cardIdsOf(result.result.combo.cards),
    });
    if (result.result.rank !== null) {
      pushLog(room, {
        t: 'finished',
        player: nicknameOf(room, playerId),
        rank: result.result.rank,
      });
    }

    this.afterGameAction(room);
    reply(ack, { ok: true, data: null });
  }

  private onPass(socket: GameSocket, ack: unknown): void {
    const context = this.gameContext(socket, ack);
    if (!context) return;
    const { room, game, playerId } = context;
    if (game.type !== 'bigTwo') {
      return reply(ack, { ok: false, error: { code: 'WRONG_GAME', message: '這個房間玩的是德州撲克' } });
    }

    const result = passTurn(room.seats, game.state, playerId);
    if (!result.ok) {
      return reply(ack, {
        ok: false,
        error: { code: result.error, message: PLAY_ERROR_MESSAGE[result.error] },
      });
    }

    pushLog(room, { t: 'pass', player: nicknameOf(room, playerId) });
    this.afterGameAction(room);
    reply(ack, { ok: true, data: null });
  }

  private onAction(
    socket: GameSocket,
    payload: { action?: unknown; amount?: unknown },
    ack: unknown,
  ): void {
    const context = this.gameContext(socket, ack);
    if (!context) return;
    const { room, game, playerId } = context;
    if (game.type !== 'holdem') {
      return reply(ack, { ok: false, error: { code: 'WRONG_GAME', message: '這個房間玩的是大老二' } });
    }

    const action = payload?.action as BetAction;
    if (!BET_ACTIONS.includes(action)) {
      return reply(ack, { ok: false, error: { code: 'BAD_ACTION', message: '不支援的動作' } });
    }
    const amount = typeof payload?.amount === 'number' ? Math.floor(payload.amount) : undefined;

    const result = applyBet(room.seats, game.state, playerId, action, amount);
    if (!result.ok) {
      return reply(ack, {
        ok: false,
        error: { code: result.error, message: BET_ERROR_MESSAGE[result.error] },
      });
    }

    pushLog(room, {
      t: 'bet',
      player: nicknameOf(room, playerId),
      action: result.result.seatAction,
    });
    if (result.result.streetAdvanced && !result.result.handOver) {
      pushLog(room, {
        t: 'street',
        street: game.state.street,
        board: cardIdsOf(game.state.board),
      });
    }

    this.afterGameAction(room);
    reply(ack, { ok: true, data: null });
  }

  private onMonopoly(socket: GameSocket, payload: { action?: unknown }, ack: unknown): void {
    const context = this.gameContext(socket, ack);
    if (!context) return;
    const { room, game, playerId } = context;
    if (game.type !== 'monopoly') {
      return reply(ack, { ok: false, error: { code: 'WRONG_GAME', message: '這個房間玩的不是大富翁' } });
    }

    const action = parseMonopolyAction(payload?.action);
    if (!action) {
      return reply(ack, { ok: false, error: { code: 'BAD_ACTION', message: '不支援的動作' } });
    }

    const result = applyMonopolyAction(room.seats, game.state, playerId, action);
    if (!result.ok) {
      return reply(ack, {
        ok: false,
        error: { code: result.error, message: MONOPOLY_ERROR_MESSAGE[result.error] },
      });
    }

    this.logMonopoly(room, result.events);
    this.afterGameAction(room);
    reply(ack, { ok: true, data: null });
  }

  private onMahjong(socket: GameSocket, payload: { action?: unknown }, ack: unknown): void {
    const action = parseMahjongAction(payload?.action);
    if (!action) {
      return reply(ack, { ok: false, error: { code: 'BAD_ACTION', message: '不支援的動作' } });
    }

    // 結算畫面按繼續：這時 state.over 是 true，會被 gameContext 擋掉，所以另外走一條路。
    if (action.kind === 'continueRound') {
      this.onMahjongContinueRound(socket, ack);
      return;
    }

    const context = this.gameContext(socket, ack);
    if (!context) return;
    const { room, game, playerId } = context;
    if (game.type !== 'taiwanMahjong') {
      return reply(ack, { ok: false, error: { code: 'WRONG_GAME', message: '這個房間玩的不是台灣麻將' } });
    }

    const before = game.state.roundResult;
    let result: { ok: true } | { ok: false; error: MahjongError };
    switch (action.kind) {
      case 'discard':
        result = discardTile(room.seats, game.state, playerId, action.tile);
        if (result.ok) {
          pushLog(room, { t: 'mahjongDiscard', player: nicknameOf(room, playerId), tile: action.tile });
        }
        break;
      case 'selfDraw':
        result = chooseSelfDrawAction(room.seats, game.state, playerId, action.action, action.tile);
        break;
      case 'respond': {
        // 戰報要記的是實際被吃／碰／槓掉的那張棄牌，不是手上湊組合用的那兩張——
        // 這張要在呼叫 respondToReaction 之前先拿，因為成功後 reaction 就被引擎清掉了。
        const eatenTile = game.state.reaction?.discardedTile;
        result = respondToReaction(room.seats, game.state, playerId, action.action, action.chiTiles);
        if (result.ok && action.action !== 'pass' && action.action !== 'hu' && eatenTile) {
          pushLog(room, {
            t: 'mahjongMeld',
            player: nicknameOf(room, playerId),
            kind: action.action,
            tiles: [eatenTile],
          });
        }
        break;
      }
    }

    if (!result.ok) {
      return reply(ack, {
        ok: false,
        error: { code: result.error, message: MAHJONG_ERROR_MESSAGE[result.error] },
      });
    }

    this.logMahjongRoundEnd(room, game.state, before);
    this.afterGameAction(room);
    reply(ack, { ok: true, data: null });
  }

  /**
   * 結算畫面按「繼續」。這時 game.state.over 一定是 true，所以不能走 gameContext（會被擋掉），
   * 另外自己找房間跟座位。全部座位都按過才馬上開下一局，不然就先廣播讓大家看到目前確認進度，
   * 等 scheduleNextMahjongRound 排的 20 秒逾時計時器自然到期。
   */
  private onMahjongContinueRound(socket: GameSocket, ack: unknown): void {
    const session = this.sessions.get(socket.id);
    if (!session?.roomId) {
      return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '你不在房間裡' } });
    }
    const room = this.rooms.get(session.roomId);
    const game = room?.game;
    if (!room || !game || game.type !== 'taiwanMahjong') {
      return reply(ack, { ok: false, error: { code: 'GAME_NOT_RUNNING', message: '遊戲尚未開始' } });
    }
    if (!room.players.has(session.playerId)) {
      return reply(ack, { ok: false, error: { code: 'SPECTATOR', message: '觀戰者不能操作' } });
    }

    const result = confirmMahjongRoundReady(room.seats, game.state, session.playerId);
    if (!result.ok) {
      return reply(ack, {
        ok: false,
        error: { code: result.error, message: MAHJONG_ERROR_MESSAGE[result.error] },
      });
    }

    if (allMahjongRoundReady(room.seats, game.state)) {
      this.advanceMahjongRound(room, game.state);
    } else {
      this.broadcastRoom(room);
    }
    reply(ack, { ok: true, data: null });
  }

  /** 一局結束（贏牌／流局）或整場比賽結束時寫戰報，只在真的產生新結果時才寫。 */
  private logMahjongRoundEnd(room: Room, state: MahjongState, before: MahjongRoundResult | null): void {
    const result = state.roundResult;
    if (!result || result === before) return;

    if (result.winType === 'draw') {
      pushLog(room, { t: 'mahjongDraw' });
    } else if (result.winnerSeat !== null) {
      const winnerId = room.seats[result.winnerSeat];
      if (winnerId) {
        // 放槍者：discard 胡的賠付只有一家出全額，找那個負數座位就是點炮的人；
        // 自摸是三家均攤都是負數，不會湊巧只有一個，所以只有 discard 才會找到人。
        let from: string | undefined;
        if (result.winType === 'discard') {
          const payerSeat = result.payments.findIndex((amount) => amount < 0);
          const payerId = payerSeat !== -1 ? room.seats[payerSeat] : null;
          if (payerId) from = nicknameOf(room, payerId);
        }
        pushLog(room, {
          t: 'mahjongWin',
          player: nicknameOf(room, winnerId),
          winType: result.winType,
          tai: result.tai,
          from,
        });
      }
    }

    if (state.matchOver) {
      const ranking = rankMahjongSeats(state)
        .map((seat) => room.seats[seat])
        .filter((id): id is PlayerId => !!id);
      pushLog(room, { t: 'mahjongOver', ranking: ranking.map((id) => nicknameOf(room, id)) });
    }
  }

  private gameContext(socket: GameSocket, ack: unknown) {
    const session = this.sessions.get(socket.id);
    if (!session?.roomId) {
      reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '你不在房間裡' } });
      return null;
    }
    const room = this.rooms.get(session.roomId);
    if (!room?.game || room.game.state.over) {
      reply(ack, { ok: false, error: { code: 'GAME_NOT_RUNNING', message: '遊戲尚未開始' } });
      return null;
    }
    if (!room.players.has(session.playerId)) {
      reply(ack, { ok: false, error: { code: 'SPECTATOR', message: '觀戰者不能出牌' } });
      return null;
    }
    return { room, game: room.game, playerId: session.playerId };
  }

  private afterGameAction(room: Room): void {
    this.checkGameOver(room);
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.scheduleTurn(room);
    this.scheduleNextHand(room);
    this.scheduleNextMahjongRound(room);
    this.scheduleMahjongNpc(room);
  }

  /**
   * 整局結束時公布名次。
   * 德州撲克是連續的現金局，沒有「整局結束」這回事，只寫攤牌戰報。
   */
  private checkGameOver(room: Room): void {
    const game = room.game;
    if (!game) return;

    switch (game.type) {
      case 'holdem':
        this.logShowdown(room, game.state);
        return;
      case 'bigTwo': {
        if (!game.state.over) return;
        const ranking = game.state.finished;
        if (ranking.length > 0) {
          pushLog(room, { t: 'bigTwoOver', ranking: ranking.map((id) => nicknameOf(room, id)) });
        }
        this.emitRanking(room, ranking);
        return;
      }
      case 'monopoly': {
        if (!game.state.over) return;
        // 結束的那一行戰報由引擎事件帶出來了，這裡只負責公布名次
        this.emitRanking(room, game.state.result?.ranking ?? []);
        return;
      }
      case 'taiwanMahjong': {
        // state.over 每一局結束都會短暫為 true（比照德州撲克的 hand-over），
        // 只有 matchOver（達到 20000 分或有人中途離開）才是真正的終局
        if (!game.state.matchOver) return;
        const ranking = rankMahjongSeats(game.state)
          .map((seat) => room.seats[seat])
          .filter((id): id is PlayerId => !!id);
        this.emitRanking(room, ranking);
        return;
      }
      default:
        assertNeverGame(game);
    }
  }

  /** 大老二與大富翁共用：停掉回合計時，把名次推給房內所有人。 */
  private emitRanking(room: Room, ranking: readonly PlayerId[]): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
    this.io.to(roomChannel(room.id)).emit('game:over', {
      ranking: ranking.map((playerId) => ({ playerId, nickname: nicknameOf(room, playerId) })),
    });
  }

  /** 一手結束時寫戰報。同一手只會寫一次。 */
  private logShowdown(room: Room, state: HoldemState): void {
    if (!state.over || !state.showdown) return;
    if (this.loggedHand.get(room.id) === state.handNo) return;
    this.loggedHand.set(room.id, state.handNo);

    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }

    if (state.board.length > 0) pushLog(room, { t: 'board', board: cardIdsOf(state.board) });
    for (const entry of state.showdown) {
      const nickname = nicknameOf(room, entry.playerId);
      if (entry.hand) {
        pushLog(room, {
          t: 'showdown',
          player: nickname,
          category: entry.hand.category,
          tiebreak: entry.hand.tiebreak.slice(),
          won: entry.won,
        });
      } else if (entry.won > 0) {
        pushLog(room, { t: 'uncontested', player: nickname, won: entry.won });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 回合計時
  // -------------------------------------------------------------------------

  private scheduleTurn(room: Room): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }

    const game = room.game;
    if (!game || game.state.over) return;

    const playerId = room.seats[game.state.turnSeat];
    const player = playerId ? room.players.get(playerId) : undefined;

    // 斷線的人不讓全桌乾等
    if (player && !player.connected) {
      game.state.turnDeadline = Math.min(game.state.turnDeadline, Date.now() + DISCONNECTED_TURN_MS);
    } else if (game.state.turnDeadline < Date.now()) {
      game.state.turnDeadline = Date.now() + TURN_MS;
    }

    const delay = Math.max(0, game.state.turnDeadline - Date.now());
    room.turnTimer = setTimeout(() => {
      room.turnTimer = null;
      this.runAutoAct(room);
    }, delay);
  }

  /**
   * 逾時代打。
   * 代打失敗（引擎回 null）也照樣走 afterGameAction —— 少了它就沒有人重新掛計時器，
   * 房間會永遠停在同一個回合。寧可 45 秒後再試一次，也不要卡死。
   */
  private runAutoAct(room: Room): void {
    const game = room.game;
    if (!game || game.state.over) return;

    const playerId = room.seats[game.state.turnSeat];
    const nickname = playerId ? nicknameOf(room, playerId) : '';

    switch (game.type) {
      case 'bigTwo': {
        const acted = autoAct(room.seats, game.state);
        if (acted?.action === 'pass') {
          pushLog(room, { t: 'timeout', player: nickname, auto: 'pass' });
        } else if (acted) {
          pushLog(room, {
            t: 'timeoutPlay',
            player: nickname,
            combo: acted.result.combo.type,
            cards: cardIdsOf(acted.result.combo.cards),
          });
          if (acted.result.rank !== null) {
            pushLog(room, { t: 'finished', player: nickname, rank: acted.result.rank });
          }
        }
        break;
      }
      case 'holdem': {
        const acted = autoActHoldem(room.seats, game.state);
        if (acted) pushLog(room, { t: 'timeout', player: nickname, auto: acted.action });
        break;
      }
      case 'monopoly': {
        const acted = autoActMonopoly(room.seats, game.state);
        if (acted) {
          pushLog(room, { t: 'timeoutMonopoly', player: nickname, phase: acted.phase });
          this.logMonopoly(room, acted.events);
        }
        break;
      }
      case 'taiwanMahjong': {
        const before = game.state.roundResult;
        const acted = autoActMahjong(game.state);
        if (acted) pushLog(room, { t: 'timeoutMahjong', player: nickname });
        this.logMahjongRoundEnd(room, game.state, before);
        break;
      }
      default:
        assertNeverGame(game);
    }

    this.afterGameAction(room);
  }

  /** 德州撲克：攤牌停留一下，再自動發下一手。 */
  private scheduleNextHand(room: Room): void {
    if (room.handTimer) {
      clearTimeout(room.handTimer);
      room.handTimer = null;
    }

    const game = room.game;
    if (game?.type !== 'holdem' || !game.state.over) return;
    if (seatedPlayers(room).length < SEAT_LIMITS.holdem.min) return;

    room.handTimer = setTimeout(() => {
      room.handTimer = null;
      if (this.rooms.get(room.id) !== room) return; // 房間已經被砍掉了
      this.startHoldemHand(room);
      this.afterGameAction(room);
    }, HOLDEM_SHOWDOWN_MS);
  }

  /**
   * 台灣麻將：一局結束（state.over）但整場比賽還沒結束（!matchOver）時，
   * 停在結算畫面等大家按繼續——電腦座位自動視為已按，全部按完就馬上開下一局；
   * 逾時 MAHJONG_ROUND_READY_MS 還沒按也不會把人踢出房間，直接照樣開下一局，
   * 真人這局就跟著留在原位繼續打，只是少按了一次確認。
   */
  private scheduleNextMahjongRound(room: Room): void {
    if (room.handTimer) {
      clearTimeout(room.handTimer);
      room.handTimer = null;
    }

    const game = room.game;
    if (game?.type !== 'taiwanMahjong' || !game.state.over || game.state.matchOver) return;
    if (game.state.phase !== 'roundEnd') return;

    this.autoConfirmMahjongNpcSeats(room, game.state);
    if (allMahjongRoundReady(room.seats, game.state)) {
      this.advanceMahjongRound(room, game.state);
      return;
    }

    room.handTimer = setTimeout(() => {
      room.handTimer = null;
      if (this.rooms.get(room.id) !== room) return; // 房間已經被砍掉了
      if (room.game !== game) return; // 這一局已經被別的事件換掉了
      this.advanceMahjongRound(room, game.state);
    }, MAHJONG_ROUND_READY_MS);
  }

  /** 真的推進到下一局：清掉等待計時器、重置局面、寫戰報、廣播。 */
  private advanceMahjongRound(room: Room, state: MahjongState): void {
    if (room.handTimer) {
      clearTimeout(room.handTimer);
      room.handTimer = null;
    }
    continueMahjongRound(state);
    const bankerId = room.seats[state.bankerSeat];
    if (bankerId) {
      pushLog(room, { t: 'mahjongRound', round: state.round, banker: nicknameOf(room, bankerId) });
    }
    this.afterGameAction(room);
  }

  /** 結算畫面的電腦座位不用真的等它「思考」，直接視為已按繼續。 */
  private autoConfirmMahjongNpcSeats(room: Room, state: MahjongState): void {
    for (let seat = 0; seat < 4; seat++) {
      if (state.roundReady[seat]) continue;
      const playerId = room.seats[seat];
      const member = playerId ? room.players.get(playerId) : undefined;
      if (member?.isNpc) state.roundReady[seat] = true;
    }
  }

  /**
   * 大廳裡有人申請加入這個已經滿位、但還有電腦座位的麻將房間，記下申請，
   * 等房主用 room:respondJoinRequest 接受或婉拒——同時只留最新一筆申請。
   */
  private onMahjongRequestJoin(
    socket: GameSocket,
    payload: { roomId?: unknown },
    ack: unknown,
  ): void {
    const session = this.sessions.get(socket.id);
    if (!session) return reply(ack, { ok: false, error: { code: 'BAD_SESSION', message: '請先連線' } });

    const roomId = cleanText(payload?.roomId, 16).toUpperCase();
    const room = this.rooms.get(roomId);
    if (!room) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '找不到這個房間' } });
    if (room.gameType !== 'taiwanMahjong') {
      return reply(ack, { ok: false, error: { code: 'WRONG_GAME', message: '只有台灣麻將房支援申請加入' } });
    }
    const isFull = room.seats.every((id) => id !== null);
    const hasNpcSeat = room.seats.some((id) => (id ? room.players.get(id)?.isNpc : false));
    if (!isFull || !hasNpcSeat) {
      return reply(ack, { ok: false, error: { code: 'NO_NPC_SEAT', message: '這個房間沒有電腦座位可以頂替' } });
    }

    room.mahjongJoinRequest = { playerId: session.playerId, nickname: session.nickname, socketId: socket.id };
    this.broadcastRoom(room);
    reply(ack, { ok: true, data: null });
  }

  /** 房主接受或婉拒目前待處理的加入申請。 */
  private onMahjongRespondJoinRequest(
    socket: GameSocket,
    payload: { accept?: unknown },
    ack: unknown,
  ): void {
    const session = this.sessions.get(socket.id);
    if (!session?.roomId) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '你不在房間裡' } });
    const room = this.rooms.get(session.roomId);
    if (!room) return reply(ack, { ok: false, error: { code: 'NO_ROOM', message: '找不到這個房間' } });
    if (room.hostId !== session.playerId) {
      return reply(ack, { ok: false, error: { code: 'NOT_HOST', message: '只有房主能處理加入申請' } });
    }
    const request = room.mahjongJoinRequest;
    if (!request) return reply(ack, { ok: false, error: { code: 'NO_REQUEST', message: '目前沒有待處理的申請' } });
    room.mahjongJoinRequest = null;

    const accept = payload?.accept === true;
    const requesterSocket = this.io.sockets.sockets.get(request.socketId);
    const requesterSession = requesterSocket ? this.sessions.get(requesterSocket.id) : undefined;
    const stillWaiting = Boolean(requesterSession && requesterSession.playerId === request.playerId);

    const npcSeat = room.seats.findIndex((id) => (id ? room.players.get(id)?.isNpc : false));

    if (!accept || !stillWaiting || npcSeat === -1) {
      if (stillWaiting && requesterSocket) {
        requesterSocket.emit('error', {
          code: !accept ? 'JOIN_REJECTED' : 'NO_NPC_SEAT',
          message: !accept ? '房主婉拒了你的加入申請' : '座位已經被別人補走了',
        });
      }
      this.broadcastRoom(room);
      reply(ack, { ok: true, data: null });
      return;
    }

    const npcId = room.seats[npcSeat]!;
    removeMember(room, npcId);

    const member: Member = {
      playerId: request.playerId,
      nickname: request.nickname,
      socketId: requesterSocket!.id,
      connected: true,
      graceTimer: null,
    };
    seatPlayer(room, member);
    requesterSession!.roomId = room.id;
    this.playerRoom.set(request.playerId, room.id);
    requesterSocket!.leave(LOBBY);
    requesterSocket!.join(roomChannel(room.id));
    requesterSocket!.emit('room:chat', { messages: room.chat });
    this.systemNotice(room, { t: 'joined', player: request.nickname });

    this.broadcastRoom(room);
    this.broadcastLobby();
    reply(ack, { ok: true, data: null });
  }

  /**
   * 台灣麻將：輪到電腦座位（不管是要出牌、自摸決策、還是回應吃碰槓胡）時，
   * 固定延遲 MAHJONG_NPC_DELAY_MS 後自動幫它做決定，遠比真人的 1 分鐘思考時間短，
   * 不然補電腦玩家測試會卡在每一步都要等真人的逾時時間。
   */
  private scheduleMahjongNpc(room: Room): void {
    if (room.npcTimer) {
      clearTimeout(room.npcTimer);
      room.npcTimer = null;
    }

    const game = room.game;
    if (game?.type !== 'taiwanMahjong' || game.state.over) return;
    const { phase } = game.state;
    if (phase !== 'discard' && phase !== 'selfDraw' && phase !== 'reaction') return;

    const actingSeat = phase === 'reaction' ? (game.state.reaction?.respondSeat ?? null) : game.state.turnSeat;
    if (actingSeat === null) return;
    const playerId = room.seats[actingSeat];
    const member = playerId ? room.players.get(playerId) : undefined;
    if (!member?.isNpc) return;

    room.npcTimer = setTimeout(() => {
      room.npcTimer = null;
      if (this.rooms.get(room.id) !== room || room.game !== game) return; // 房間或這一局已經被換掉了
      this.runMahjongNpcAction(room, game.state);
    }, MAHJONG_NPC_DELAY_MS);
  }

  private runMahjongNpcAction(room: Room, state: MahjongState): void {
    const context = {
      allDiscards: state.players.map((p) => p.discards),
      allMeldsPublic: state.players.map((p, seat) => ({ seat, melds: p.melds })),
      wallCount: state.wall.length,
      bankerSeat: state.bankerSeat,
    };

    if (state.phase === 'discard') {
      const seat = state.turnSeat;
      const playerId = room.seats[seat];
      const player = state.players[seat];
      if (playerId && player) {
        const tile = aiChooseDiscard(player, context);
        const result = discardTile(room.seats, state, playerId, tile);
        if (result.ok) pushLog(room, { t: 'mahjongDiscard', player: nicknameOf(room, playerId), tile });
      }
    } else if (state.phase === 'selfDraw' && state.selfDraw) {
      const seat = state.turnSeat;
      const playerId = room.seats[seat];
      const player = state.players[seat];
      if (playerId && player) {
        const before = state.roundResult;
        const decision = aiSelfDrawAction(player, state.selfDraw);
        chooseSelfDrawAction(room.seats, state, playerId, decision.action, decision.tile);
        this.logMahjongRoundEnd(room, state, before);
      }
    } else if (state.phase === 'reaction' && state.reaction) {
      const reaction = state.reaction;
      const playerId = room.seats[reaction.respondSeat];
      const player = state.players[reaction.respondSeat];
      if (playerId && player) {
        const before = state.roundResult;
        const decision = aiRespond(player, reaction.options, {
          ...context,
          discardedTile: reaction.discardedTile,
          chiOptions: reaction.chiOptions,
        });
        const result = respondToReaction(room.seats, state, playerId, decision.action, decision.chiTiles);
        if (result.ok && decision.action !== 'pass' && decision.action !== 'hu') {
          pushLog(room, {
            t: 'mahjongMeld',
            player: nicknameOf(room, playerId),
            kind: decision.action,
            tiles: [reaction.discardedTile],
          });
        }
        this.logMahjongRoundEnd(room, state, before);
      }
    }

    this.afterGameAction(room);
  }
}
