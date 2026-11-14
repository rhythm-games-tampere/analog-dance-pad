import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { untrack } from 'svelte';
import serversConfig from './servers.config.json';

// ---- Protocol types (see adp-tool Device.cpp / Players.cpp) ----

export interface Sensor {
	threshold: number; // normalized 0..1
	releaseThreshold: number; // normalized 0..1
	value: number; // normalized 0..1
	resistorValue: number; // raw digipot byte 0..255 (NOT normalized)
	button: number; // 0 = unmapped, else 1-based
	pressed: boolean; // pad-authoritative activation
	disabled?: boolean; // the pad doesn't read this sensor (ADC_DISABLED)
}

/** Fields a client may write back per sensor (positional in the `sensors` message). */
export type SensorPatch = Partial<
	Pick<Sensor, 'threshold' | 'releaseThreshold' | 'resistorValue' | 'button'>
>;

/** LED lighting config, in the same shape a saved profile uses. */
export interface LightRule {
	fadeOn: boolean;
	fadeOff: boolean;
	onColor: string;
	offColor: string;
	onFadeColor: string;
	offFadeColor: string;
}

export interface LedMapping {
	lightRuleIndex: number;
	sensorIndex: number;
	ledIndexBegin: number;
	ledIndexEnd: number;
}

/** msgType 1, one per pad per tick. What doesn't change while a pad runs is in DeviceInfo. */
export interface Snapshot {
	msgType: 1;
	pad: string; // HID path: how messages address this pad
	/** Input reports per second. A pad at rest may send none, so 0 isn't a dead link. */
	pollingRate: number;
	releaseMode: number; // 0 none, 2 per-sensor (1 = legacy global, treated as per-sensor)
	unsaved: boolean; // edits not yet in the pad's EEPROM (saved ~2s after the last one)
	saveFailed: boolean; // the last save to the pad failed; the server retries every 2s
	saving?: boolean; // an EEPROM save is running: values are frozen until it's done (up to ~2s)
	sensors: Sensor[];
}

/** Lights message (msgType 4) — sent on change / periodically, not per snapshot. */
export interface Lights {
	lightRules: LightRule[];
	ledMappings: LedMapping[];
}

/** A connected pad (msgType 2). */
export interface DeviceInfo {
	id: string; // HID path
	name: string; // stable identity: profiles are stored per pad name
	sensorCount: number;
	firmware?: string; // e.g. "2.1"
	maxSensorValue: number; // device counts that 1.0 stands for
	numButtons: number; // mappable buttons this pad exposes
	featureDigipot: boolean; // pad supports per-sensor gain
	featureLights: boolean; // pad has configurable lights
}

/** A player from the shared LocalProfiles folder (msgType 3). */
export interface Player {
	name: string;
	avatar: boolean;
	profiles: Record<string, number>; // pad name -> stored profile count
}

/** Server-owned selection on one pad (msgType 5). */
export interface PadState {
	name: string;
	player?: string;
	profileId?: string;
	profileName?: string;
	recent?: string[];
	/** The pad was unplugged before its last edits were saved: it came back with older settings. */
	editsLost?: boolean;
	/** The game side (1 or 2) whose player the game puts on this pad; absent: none. */
	side?: number;
	/** Display names of the pad's buttons, keyed by 1-based button number. */
	buttonNames?: Record<string, string>;
}

/** A stored profile (msgType 6). Captures thresholds+release, gain and lights. */
export interface Profile {
	id: string; // filename stem, unique per player+pad
	name: string;
	description?: string;
	sensorCount: number; // only loadable onto a pad with this many sensors
	savedAt?: number; // unix seconds
	sensors: Array<Pick<Sensor, 'threshold' | 'releaseThreshold' | 'resistorValue'>>;
	lightRules?: LightRule[];
	ledMappings?: LedMapping[];
}

/** Ops the server answers with a result (msgType 8). `configure` (sensor and
 * lights edits) is answered only when it fails. */
export type Op =
	| 'loadProfile'
	| 'saveProfile'
	| 'importProfile'
	| 'updateProfile'
	| 'deleteProfile'
	| 'selectPlayer'
	| 'setSide'
	| 'rename'
	| 'renameButton'
	| 'setReleaseMode'
	| 'configure';

/** The server's answer to one of this client's ops (msgType 8). */
export interface OpResult {
	op: Op;
	pad: string;
	ok: boolean;
	error: string; // '' when ok
	name: string; // the profile's (or, for rename/renameButton, the pad's/button's) name, when there is one
	requestId?: string; // echoed from the request
}

/** A short-lived message for the user, e.g. an op result. */
export interface Notice {
	ok: boolean;
	text: string;
	op?: Op;
}

export interface Avatar {
	mime: string; // '' when the player has none
	url: string; // data: URL
}

/** Mapped sensors grouped per button, plus each sensor's index in the snapshot. */
export interface MappedSensor {
	index: number;
	sensor: Sensor;
}

export interface ButtonGroup {
	button: number; // 1-based button number
	sensors: MappedSensor[]; // sensors mapped to this button, in snapshot-index order
}

export interface ServerConfig {
	name: string;
	url: string;
}

/** One route per screen, in flow order; the selection travels in the query. */
const ROUTES = {
	server: '/',
	pad: '/pad/',
	player: '/player/',
	profile: '/profile/',
	tune: '/tune/',
	arrow: '/tune/arrow/',
	config: '/config/'
} as const;
export type Screen = keyof typeof ROUTES;
export const SCREENS = Object.keys(ROUTES) as Screen[];
export const screenOf = (routeId: string | null): Screen =>
	SCREENS.find((s) => ROUTES[s] === `${routeId ?? ''}/`.replace('//', '/')) ?? 'server';

const SELECTION = ['server', 'pad', 'player'] as const;
/** How many of server, pad, player a screen's links carry / the screen can't do without. */
const CARRIES: Record<Screen, number> = {
	server: 0,
	pad: 1,
	player: 2,
	profile: 3,
	tune: 3,
	arrow: 3,
	config: 3
};
const REQUIRES: Record<Screen, number> = { ...CARRIES, config: 2 };

export interface Selection {
	server: string | null; // server name
	pad: string | null; // pad name
	player: string | null;
	button: number | null; // the arrow screen's button
}

/** The player without profiles of their own: always there, never in the server's list (Players.h GUEST). */
export const GUEST = 'Guest';
export const MAX_PROFILES = 5; // per player per pad, enforced by the server too

// Reconcile tolerance for float thresholds. Must sit between the device's
// quantization noise (thresholds are stored /maxSensorValue <= 0.0012) and the smallest
// deliberate edit (the +/- fine-tune buttons nudge by 1% = 0.01). If EPS were
// >= that step, reconcile() would treat the pre-update snapshot as already
// converged and delete a single-percent nudge before the device applied it.
const EPS = 0.004;
const SEND_THROTTLE_MS = 40;
// An optimistic edit the pad hasn't echoed back by then was refused or clamped
// by the server; drop it so the UI shows the pad's real value again.
const PENDING_TTL_MS = 1000;
// No snapshot for this long while open => pad considered gone. The server sends
// one at least every 250ms, also while a pad saves; only a profile load holds
// all of its pads up, for ~150ms.
const STALE_MS = 2000;
// A profile load the server hasn't answered by then is given up on (it may
// wait behind the pad's save, which can take ~2s, then take ~150ms itself).
const LOAD_TIMEOUT_MS = 10000;
/** The adp-tool protocol this client speaks (WebsocketServer.h PROTOCOL_VERSION). */
const PROTOCOL_VERSION = 3;
/** Lowest release threshold the server stores, in device counts (Reporter.h MIN_RELEASE_COUNTS). */
const MIN_RELEASE_COUNTS = 10;
const MAX_BACKOFF_MS = 5000;
/** Marks the saves commit() sends, so their success isn't announced. */
const AUTOSAVE = 'autosave';
const NOTICE_MS = 4000;
/** How long a fresh page waits for every server's pad states before deciding where to open. */
const OPEN_WAIT_MS = 2000;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

interface ConnEvents {
	/** A snapshot for `pad` arrived. */
	snapshot: (conn: Conn, pad: string) => void;
	/** The server answered one of this client's profile ops. */
	result: (conn: Conn, result: OpResult) => void;
}

/** One WebSocket connection to a single adp-tool server. */
class Conn {
	readonly endpoint: string;
	readonly name: string;
	status: 'connecting' | 'open' | 'offline' = $state('connecting');
	deviceList: DeviceInfo[] = $state([]);
	/** True once this connection's device list arrived (false while (re)connecting). */
	devicesKnown = $state(false);
	/** Replaced (never mutated) per message: raw state skips deep-proxying 60Hz data. */
	snapshots: Record<string, Snapshot> = $state.raw({});
	/** Arrival time per pad; not reactive, read alongside `snapshots` and the ticking clock. */
	snapshotAt: Record<string, number> = {};
	lights: Record<string, Lights> = $state({});
	players: Player[] = $state([]);
	/** False while the server can't reach LocalProfiles; `players` is then the last known list. */
	localProfilesOk = $state(true);
	padStates: Record<string, PadState> = $state({});
	/** True once this connection's pad states arrived (false while (re)connecting). */
	padStatesKnown = $state(false);
	/** player -> pad name -> profiles, filled by listProfiles replies. */
	profiles: Record<string, Record<string, Profile[]>> = $state({});
	/** player -> avatar; null while requested. */
	avatars: Record<string, Avatar | null> = $state({});
	/** Set when the server speaks another protocol version than this client. */
	protocolError: string | null = $state(null);

	#ws: WebSocket | null = null;
	#backoff = 500;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#closed = false;
	/** Pads this client wants snapshots for: '*' (server default), a pad path, or '' for none. */
	#subscription = '*';
	#events: ConnEvents;

	constructor(server: ServerConfig, events: ConnEvents) {
		this.endpoint = server.url;
		this.name = server.name;
		this.#events = events;
		this.#open();
	}

	#open() {
		this.status = 'connecting';
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.endpoint);
		} catch {
			this.#scheduleReconnect();
			return;
		}
		this.#ws = ws;
		// Events of a socket we've already replaced must not touch the new one.
		ws.addEventListener('open', () => {
			if (ws !== this.#ws) return;
			this.status = 'open';
			this.#backoff = 500;
			// The server sends its current pads, players and lights on connect.
			if (this.#subscription !== '*') this.send({ subscribe: this.#subscription });
		});
		ws.addEventListener('message', (ev) => ws === this.#ws && this.#onMessage(ev.data));
		ws.addEventListener('close', () => ws === this.#ws && this.#onDown());
		ws.addEventListener('error', () => ws === this.#ws && this.#onDown());
	}

	#onMessage(data: string) {
		let m: unknown;
		try {
			m = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof m !== 'object' || m === null) return;
		const msg = m as { msgType?: number; pad?: string };
		if (msg.msgType === 0) {
			const h = m as { protocol?: number; server?: string };
			this.protocolError =
				h.protocol === PROTOCOL_VERSION
					? null
					: `${this.name} runs ADP Server ${h.server ?? '?'} (protocol ${h.protocol ?? '?'}), ` +
						`this page speaks protocol ${PROTOCOL_VERSION}: reload the page or update the server`;
		} else if (msg.msgType === 1) {
			const s = m as Snapshot;
			this.snapshotAt[s.pad] = Date.now();
			this.snapshots = { ...this.snapshots, [s.pad]: s };
			this.#events.snapshot(this, s.pad);
		} else if (msg.msgType === 2) {
			this.deviceList = (m as { devices: DeviceInfo[] }).devices;
			this.devicesKnown = true;
		} else if (msg.msgType === 3) {
			const pl = m as { players: Player[]; localProfiles?: boolean };
			this.players = pl.players;
			this.localProfilesOk = pl.localProfiles ?? true;
		} else if (msg.msgType === 4) {
			if (msg.pad) this.lights[msg.pad] = m as Lights;
		} else if (msg.msgType === 5) {
			this.padStates = (m as { pads: Record<string, PadState> }).pads;
			this.padStatesKnown = true;
		} else if (msg.msgType === 6) {
			const r = m as { player: string; pads: Record<string, Profile[]> };
			this.profiles[r.player] = r.pads;
		} else if (msg.msgType === 7) {
			const a = m as { name: string; mime: string; data: string };
			this.avatars[a.name] = { mime: a.mime, url: a.mime ? `data:${a.mime};base64,${a.data}` : '' };
		} else if (msg.msgType === 8) {
			this.#events.result(this, m as OpResult);
		}
	}

	#onDown() {
		if (this.#closed) return;
		this.status = 'offline';
		this.snapshots = {};
		this.deviceList = [];
		this.devicesKnown = false;
		this.lights = {};
		this.padStates = {};
		this.padStatesKnown = false;
		// Requests made while down were dropped: forget those so they are asked
		// again, but keep fetched avatars (they can be MBs each).
		this.avatars = Object.fromEntries(Object.entries(this.avatars).filter(([, a]) => a !== null));
		this.#scheduleReconnect();
	}

	#scheduleReconnect() {
		if (this.#closed || this.#reconnectTimer) return;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.#open();
		}, this.#backoff);
		this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
	}

	/** Which pads to stream snapshots for; resent on every reconnect. */
	subscribe(sub: string) {
		if (sub === this.#subscription) return;
		this.#subscription = sub;
		this.send({ subscribe: sub });
	}

	/** False if not connected: the message was dropped. */
	send(obj: unknown): boolean {
		if (!this.#ws || this.status !== 'open') return false;
		this.#ws.send(JSON.stringify(obj));
		return true;
	}

	close() {
		this.#closed = true;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#ws?.close();
	}
}

const SERVER_KEY = 'adp-server';
const SHARED_KEY = 'adp-shared';
const PLAYER_KEY = 'adp-player';

function stored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function store(key: string, value: string | null) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		/* storage unavailable */
	}
}
/** Server list is baked in at build time from servers.config.json — not user-editable. */
const SERVERS: ServerConfig[] = serversConfig.servers;

class PadsStore {
	readonly servers = SERVERS;
	conns: Conn[] = $state([]);

	// ---- Selection: server -> pad -> player -> profile ----
	// Mirrors the URL (see sync): links change it, nothing else does.
	step: Screen = $state('server');
	server: string | null = $state(null); // endpoint url, remembered per device
	padName: string | null = $state(null);
	player: string | null = $state(null);
	button: number | null = $state(null);
	/** Set when arriving from the player screen; the profile screen auto-loads a lone profile once. */
	autoLoad = $state(false);

	/** Optimistic per-sensor edits for the selected pad, keyed by sensor index. */
	pending: Record<number, SensorPatch> = $state({});
	now = $state(0); // ticking clock so staleness stays reactive
	/** Shown as a toast for a few seconds (op results, send failures). */
	notice: Notice | null = $state(null);
	/** Id of the profile being loaded onto the selected pad, until the server answers. */
	loadingProfile: string | null = $state(null);

	#clock: ReturnType<typeof setInterval> | null = null;
	#sendTimer: ReturnType<typeof setTimeout> | null = null;
	#stopEffects: (() => void) | null = null;
	/** When each pending sensor patch was last edited (see PENDING_TTL_MS). */
	#pendingAt: Record<number, number> = {};
	/** Edits not sent yet; a flush sends only these, not every unconfirmed one. */
	#unsent: Record<number, SensorPatch> = {};
	#noticeTimer: ReturnType<typeof setTimeout> | undefined;
	#loadTimer: ReturnType<typeof setTimeout> | undefined;
	/** The running load came from autoLoad: its profile screen is skipped by Back. */
	#loadReplaces = false;
	/** An edit was committed: store the pad's settings in the loaded profile once it has them. */
	#saveWanted = false;
	/** HID path the pad name last resolved to, to follow a rename. */
	#lastPath: string | null = null;

	/**
	 * A shared device belongs to the arcade and stays with its cab; a personal
	 * one (the default) follows its player between pads. Kept per device.
	 */
	shared = $state(false);
	/** The player last tuned on this personal device. */
	#myPlayer: string | null = null;
	/** Each pad's player as last seen, by endpoint + path; kept while a server is down. */
	#padPlayers = new Map<string, string | undefined>();
	/** A fresh page hasn't decided yet where its player is (see #open). */
	#opening = $state(false);
	#startedAt = 0;

	/** Call once from the browser (onMount). Safe to call more than once. */
	start() {
		if (!browser || this.#clock) return;
		this.now = this.#startedAt = Date.now();
		this.shared = stored(SHARED_KEY) === '1';
		this.#myPlayer = this.shared ? null : stored(PLAYER_KEY);
		this.#opening = !!this.#myPlayer;
		this.#clock = setInterval(() => (this.now = Date.now()), 250);
		this.conns = SERVERS.map(
			(s) =>
				new Conn(s, {
					snapshot: (c, pad) => {
						// Clear optimistic edits the selected pad has caught up to.
						if (c === this.conn && pad === this.pad) {
							this.reconcile();
							this.#autosave();
						}
					},
					result: (c, r) => this.#onResult(c, r)
				})
		);
		// Stream only what's on screen: every pad of the selected server while
		// picking one, then just the picked pad; nothing from other servers
		// (they are only asked for profiles to copy).
		this.#stopEffects = $effect.root(() => {
			$effect(() => {
				for (const c of this.conns)
					c.subscribe(
						c.endpoint !== this.server ? '' : this.step === 'pad' || !this.pad ? '*' : this.pad
					);
			});
			// Profiles are listed per pad name: after the selected pad is renamed
			// (here or by another client), list them again under the new name.
			let last: { pad: string; name: string } | null = null;
			$effect(() => {
				const d = this.device;
				if (!d) return;
				const renamed = last?.pad === d.id && last.name !== d.name;
				untrack(() => {
					if (renamed && this.player) this.#requestProfiles(this.player);
				});
				last = { pad: d.id, name: d.name };
			});
			// A reload lands on a screen before any socket is open: list the
			// player's profiles as each server comes up.
			$effect(() => {
				const player = this.player;
				if (!player) return;
				for (const c of this.conns) if (c.status === 'open') c.send({ listProfiles: { player } });
			});
			// The URL names a pad the server doesn't have: renamed (follow it) or
			// unplugged (pick another). Only once the device list is in.
			$effect(() => {
				const path = this.pad;
				const c = this.conn;
				if (path) {
					this.#lastPath = path;
					return;
				}
				if (!this.padName || c?.status !== 'open' || !c.devicesKnown) return;
				const renamed = c.deviceList.find((d) => d.id === this.#lastPath);
				untrack(() =>
					goto(renamed ? this.href(this.step, { pad: renamed.name }) : this.href('pad'), {
						replaceState: true
					})
				);
			});
			$effect(() => {
				if (!this.#opening) return;
				const settled = this.conns.every(
					(c) => c.status === 'offline' || (c.status === 'open' && c.padStatesKnown)
				);
				if (settled || this.now - this.#startedAt >= OPEN_WAIT_MS) untrack(() => this.#open());
			});
			$effect(() => {
				for (const c of this.conns) for (const st of Object.values(c.padStates)) void st.player;
				untrack(() => this.#watchPads());
			});
		});
	}

	/** A personal device opens where its player is active, if that is exactly one pad. */
	#open() {
		this.#opening = false;
		const me = this.#myPlayer;
		const tuning = this.step === 'tune' || this.step === 'arrow';
		if (!me || !(this.step === 'server' || this.step === 'pad' || (tuning && this.player === me)))
			return;
		const at = this.conns.flatMap((c) =>
			Object.values(c.padStates)
				.filter((st) => st.player === me)
				.map((st) => ({ server: c.name, pad: st.name }))
		);
		if (tuning && at.some((a) => a.server === this.serverName && a.pad === this.padName)) return;
		if (at.length === 1) goto(this.href('tune', { ...at[0], player: me }), { replaceState: true });
		else if (tuning) goto(this.href('pad'), { replaceState: true });
	}

	/** The user navigated before the page decided where to open: leave them there. */
	userNavigated() {
		this.#opening = false;
	}

	/**
	 * On a personal device: follows its player to the pad they were just put on
	 * (on any server), and leaves the tuning screens when the pad being tuned
	 * goes to someone else.
	 */
	#watchPads() {
		const me = this.shared ? null : this.#myPlayer;
		const tuning = this.step === 'tune' || this.step === 'arrow';
		let follow: { server: string; pad: string } | null = null;
		let left = false;
		for (const c of this.conns)
			for (const [path, st] of Object.entries(c.padStates)) {
				const key = `${c.endpoint}\n${path}`;
				const known = this.#padPlayers.has(key);
				const was = this.#padPlayers.get(key);
				this.#padPlayers.set(key, st.player);
				if (!known || was === st.player) continue;
				if (me && st.player === me) follow = { server: c.name, pad: st.name };
				else if (was === this.player && c === this.conn && path === this.pad) left = true;
			}
		if (this.shared) return;
		if (follow && this.step !== 'config') {
			this.#opening = false;
			const here =
				follow.server === this.serverName &&
				follow.pad === this.padName &&
				this.player === me &&
				(tuning || this.step === 'profile');
			if (here) return;
			this.showNotice({ ok: true, text: `${me} is now on ${follow.pad}` });
			goto(this.href('tune', { ...follow, player: me }), { replaceState: tuning });
		} else if (left && tuning) {
			this.showNotice({ ok: true, text: `${this.player} is no longer on ${this.padName}` });
			goto(this.href('pad'), { replaceState: true });
		}
	}

	setShared(shared: boolean) {
		this.shared = shared;
		store(SHARED_KEY, shared ? '1' : null);
		if (shared) {
			this.#myPlayer = null;
			this.#opening = false;
			store(PLAYER_KEY, null);
		} else if (this.player && this.player !== GUEST) {
			this.#myPlayer = this.player;
			store(PLAYER_KEY, this.player);
		}
	}

	stop() {
		clearTimeout(this.#noticeTimer);
		this.#setLoading(null);
		if (this.#clock) clearInterval(this.#clock);
		this.#clock = null;
		this.#stopEffects?.();
		this.#stopEffects = null;
		for (const c of this.conns) c.close();
		this.conns = [];
	}

	// ---- Navigation ----

	/** The URL of `screen`, for the current selection with `sel` on top. */
	href(screen: Screen, sel: Partial<Selection> = {}): string {
		const cur: Selection = {
			server: this.serverName || null,
			pad: this.padName,
			player: this.player,
			button: this.button,
			...sel
		};
		const q = SELECTION.slice(0, CARRIES[screen]).flatMap((k) => (cur[k] ? [[k, cur[k]]] : []));
		if (screen === 'arrow' && cur.button) q.push(['button', String(cur.button)]);
		const qs = new URLSearchParams(q).toString();
		return resolve(ROUTES[screen]) + (qs ? `?${qs}` : '');
	}

	/** The server this device used last, to skip the server screen on a fresh visit. */
	get rememberedServer(): string | null {
		try {
			const url = localStorage.getItem(SERVER_KEY);
			return SERVERS.find((c) => c.url === url)?.name ?? null;
		} catch {
			return null;
		}
	}

	/** Takes the selection from the URL; a screen missing part of it goes back to pick it. */
	sync(screen: Screen, q: URLSearchParams) {
		const server = SERVERS.find((c) => c.name === q.get('server'));
		const padName = q.get('pad') || null;
		const player = q.get('player') || null;
		const have = !server ? 0 : !padName ? 1 : !player ? 2 : 3;
		if (have < REQUIRES[screen]) {
			const back = SCREENS[have];
			goto(this.href(back, { server: server?.name ?? null, pad: padName, player }), {
				replaceState: true
			});
			return;
		}
		const padChanged = (server?.url ?? null) !== this.server || padName !== this.padName;
		const entered = screen !== this.step;
		this.server = server?.url ?? null;
		this.padName = padName;
		this.player = player;
		this.button = Number(q.get('button')) || null;
		this.step = screen;
		if (padChanged) {
			this.#lastPath = null;
			this.#setLoading(null);
			this.#clearEdits();
		}
		if (server)
			try {
				localStorage.setItem(SERVER_KEY, server.url);
			} catch {
				/* storage unavailable */
			}
		if (
			!this.shared &&
			player &&
			player !== GUEST &&
			player !== this.#myPlayer &&
			(screen === 'tune' || screen === 'arrow')
		) {
			this.#myPlayer = player;
			store(PLAYER_KEY, player);
		}
		// pick up just-created players
		if (screen === 'player' && (entered || padChanged)) this.conn?.send({ rescanPlayers: true });
		if (screen === 'profile' && player && entered) this.#requestProfiles(player);
	}

	/** Every server keeps only its own pads' profiles: ask them all (copy sources). */
	#requestProfiles(player: string) {
		for (const c of this.conns) c.send({ listProfiles: { player } });
	}

	// ---- Derived views ----

	get conn(): Conn | undefined {
		return this.conns.find((c) => c.endpoint === this.server);
	}

	get serverName(): string {
		return SERVERS.find((c) => c.url === this.server)?.name ?? '';
	}

	/** The selected server's pads: the P1 side's first, then P2's, then those without a side. */
	get devices(): DeviceInfo[] {
		const c = this.conn;
		if (!c) return [];
		const order = (d: DeviceInfo) => c.padStates[d.id]?.side || 3;
		return [...c.deviceList].sort((a, b) => order(a) - order(b));
	}

	get device(): DeviceInfo | undefined {
		return this.devices.find((d) => d.name === this.padName);
	}

	/** The selected pad's HID path on the selected server, while it is connected. */
	get pad(): string | null {
		return this.device?.id ?? null;
	}

	/** Pad names used more than once on the selected server, where profiles are keyed by pad name. */
	get duplicatePadNames(): string[] {
		const names = this.devices.map((d) => d.name);
		return names.filter((n, i) => names.indexOf(n) !== i);
	}

	/** A pad's live snapshot on the selected server, or null if stale/missing. */
	snapshotOf(path: string): Snapshot | null {
		const c = this.conn;
		if (!c || c.status !== 'open') return null;
		const s = c.snapshots[path];
		return s && this.now - (c.snapshotAt[path] ?? 0) < STALE_MS ? s : null;
	}

	padStateOf(path: string): PadState | undefined {
		return this.conn?.padStates[path];
	}

	get activeSnapshot(): Snapshot | null {
		return this.pad ? this.snapshotOf(this.pad) : null;
	}

	get padState(): PadState | undefined {
		return this.pad ? this.padStateOf(this.pad) : undefined;
	}

	/** The selected pad's name for `button`, if it has one. */
	buttonName(button: number): string | undefined {
		return this.padState?.buttonNames?.[button];
	}

	/** `button`'s name, else "Button N". */
	buttonLabel(button: number): string {
		return this.buttonName(button) ?? `Button ${button}`;
	}

	/** Why the selected server can't be used by this page, if it can't. */
	get protocolError(): string | null {
		return this.conn?.protocolError ?? null;
	}

	get localProfilesOk(): boolean {
		return this.conn?.localProfilesOk ?? true;
	}

	get players(): Player[] {
		return this.conn?.players ?? [];
	}

	/** Profiles of `player` on pad `padName` (once listProfiles has answered). */
	profilesOf(player: string, padName: string): Profile[] | undefined {
		const byPad = this.conn?.profiles[player];
		return byPad ? (byPad[padName] ?? []) : undefined;
	}

	/** The selected player's profiles on the selected pad; undefined while loading. */
	get playerProfiles(): Profile[] | undefined {
		const d = this.device;
		return this.player && d ? this.profilesOf(this.player, d.name) : undefined;
	}

	/** The selected player's compatible profiles on *other* pads, on any server (copy sources). */
	get copySources(): Array<{ server: string; pad: string; profile: Profile }> {
		const d = this.device;
		const player = this.player;
		if (!d || !player) return [];
		return this.conns.flatMap((c) =>
			Object.entries(c.profiles[player] ?? {}).flatMap(([pad, list]) =>
				c === this.conn && pad === d.name
					? []
					: list
							.filter((p) => p.sensorCount === d.sensorCount)
							.map((profile) => ({ server: c.name, pad, profile }))
			)
		);
	}

	/** Whether per-sensor release thresholds are in effect (false only in "None" mode). */
	get releaseEnabled(): boolean {
		return (this.activeSnapshot?.releaseMode ?? 2) !== 0;
	}

	/** Every sensor of the selected pad (mapped or not), with optimistic edits overlaid. */
	get allSensors(): MappedSensor[] {
		const snap = this.activeSnapshot;
		if (!snap) return [];
		return snap.sensors.map((s, index) => {
			const p = this.pending[index];
			return { index, sensor: p === undefined ? s : { ...s, ...p } };
		});
	}

	get mappedSensors(): MappedSensor[] {
		return this.allSensors.filter((m) => m.sensor.button > 0);
	}

	/** Mapped sensors grouped by button, sorted ascending; empty buttons skipped. */
	get buttonGroups(): ButtonGroup[] {
		return groupByButton(this.mappedSensors);
	}

	/** The profile currently on the selected pad, if it belongs to the selected player. */
	get loadedProfile(): Profile | null {
		const st = this.padState;
		if (!st?.profileId || st.player !== this.player) return null;
		return this.playerProfiles?.find((p) => p.id === st.profileId) ?? null;
	}

	/** A player's avatar, once fetched (see requestAvatar). undefined = none / not yet. */
	avatar(player: Player): Avatar | undefined {
		return this.conn?.avatars[player.name] ?? undefined;
	}

	/** Fetches a player's avatar once per connection. Writes state: call from an effect, not a derived. */
	requestAvatar(player: Player) {
		const c = this.conn;
		if (!c || c.status !== 'open' || !player.avatar || player.name in c.avatars) return;
		c.avatars[player.name] = null;
		c.send({ getAvatar: player.name });
	}

	/** Drops optimistic and unsent edits (they belong to the previous pad or profile). */
	#clearEdits() {
		this.pending = {};
		this.#unsent = {};
		this.#saveWanted = false;
	}

	#setLoading(id: string | null) {
		clearTimeout(this.#loadTimer);
		this.loadingProfile = id;
		if (id)
			this.#loadTimer = setTimeout(() => {
				this.loadingProfile = null;
				this.showNotice({ ok: false, text: "The pad didn't answer the profile load" });
			}, LOAD_TIMEOUT_MS);
	}

	// ---- Notices ----

	showNotice(notice: Notice) {
		this.notice = notice;
		clearTimeout(this.#noticeTimer);
		this.#noticeTimer = setTimeout(() => (this.notice = null), NOTICE_MS);
	}

	#onResult(c: Conn, r: OpResult) {
		if (c !== this.conn) return;
		if (r.op === 'loadProfile' && r.pad === this.pad) this.#setLoading(null);
		if (r.ok && r.requestId === AUTOSAVE) return;
		this.showNotice(
			r.ok
				? { ok: true, op: r.op, text: OP_DONE[r.op]?.(r.name) ?? 'Done' }
				: { ok: false, op: r.op, text: `Couldn't ${OP_VERBS[r.op] ?? r.op}: ${r.error}` }
		);
		// A loaded or new profile is what the pad holds now: on to tuning it.
		if (
			r.ok &&
			(r.op === 'loadProfile' || r.op === 'saveProfile') &&
			r.pad === this.pad &&
			this.step === 'profile'
		)
			goto(this.href('tune'), { replaceState: r.op === 'loadProfile' && this.#loadReplaces });
		if (r.ok && r.op === 'selectPlayer' && r.pad === this.pad && this.step === 'profile')
			goto(this.href('tune'), { replaceState: true });
	}

	// ---- Profile actions (selected pad + player) ----

	/** Sends to the selected pad; false (with a notice) if it couldn't be sent. */
	#sendPad(msg: Record<string, unknown>): boolean {
		const sent = !!this.pad && !!this.conn?.send({ pad: this.pad, ...msg });
		if (!sent) this.showNotice({ ok: false, text: `Not connected to ${this.serverName}` });
		return sent;
	}

	/** Asks before the pad is taken from another player (the guest is nobody's). */
	#mayTakeOver(): boolean {
		const cur = this.padState?.player;
		return (
			!cur ||
			cur === GUEST ||
			cur === this.player ||
			window.confirm(`${cur} is active on ${this.padName}. Switch the pad to ${this.player}?`)
		);
	}

	/** Shows as loading (loadingProfile) until the server answers: the pad is busy meanwhile. */
	loadProfile(id: string, auto = false) {
		if (this.loadingProfile || !this.#mayTakeOver()) return;
		if (this.#sendPad({ loadProfile: { player: this.player, id } })) {
			this.#loadReplaces = auto;
			this.#clearEdits();
			this.#setLoading(id);
		}
	}

	/**
	 * Puts the selected player's last used profile on the pad; one without any
	 * gets a "default" profile copied from the guest's. Moves on to tuning (see
	 * #onResult).
	 */
	selectPlayer() {
		if (this.#mayTakeOver() && this.#sendPad({ selectPlayer: { player: this.player } }))
			this.#clearEdits();
	}

	/** Loads/saves move on to tuning once the server confirms (see #onResult). */
	saveProfileAs(name: string) {
		if (this.#mayTakeOver()) this.#sendPad({ saveProfile: { player: this.player, name } });
	}

	/**
	 * An edit is complete (a drag was released, a button pressed): the loaded
	 * profile follows the pad. Call after the edit; a drag in progress isn't one.
	 */
	commit() {
		this.#saveWanted = true;
		this.#autosave();
	}

	/** The server saves what the pad holds, so this waits until the pad has echoed every edit. */
	#autosave() {
		if (!this.#saveWanted || Object.keys(this.pending).length > 0) return;
		this.#saveWanted = false;
		const p = this.loadedProfile;
		if (p) this.#sendPad({ saveProfile: { player: this.player, id: p.id }, requestId: AUTOSAVE });
	}

	/**
	 * Store a copy of `profile` (read from this or any other server) on the
	 * selected pad as `name`. Purely client-side across servers: the profile
	 * travels in the message, the target server validates and stores it.
	 */
	copyProfile(profile: Profile, name: string) {
		this.#sendPad({ importProfile: { player: this.player, name, profile } });
	}

	updateProfile(id: string, name: string, description: string) {
		this.#sendPad({ updateProfile: { player: this.player, id, name, description } });
	}

	deleteProfile(id: string) {
		this.#sendPad({ deleteProfile: { player: this.player, id } });
	}

	// ---- Sensor edits (optimistic, throttled) ----

	#patch(sensorIndex: number, patch: SensorPatch) {
		this.#pendingAt[sensorIndex] = Date.now();
		this.pending = {
			...this.pending,
			[sensorIndex]: { ...this.pending[sensorIndex], ...patch }
		};
		this.#unsent[sensorIndex] = { ...this.#unsent[sensorIndex], ...patch };
		this.#scheduleSend();
	}

	/** Optimistically set a sensor threshold and (throttled) push it to the pad. */
	setThreshold(sensorIndex: number, value: number) {
		const v = clamp01(value);
		const patch: SensorPatch = { threshold: v };
		// Keep release at its current ratio of threshold so the release marker
		// tracks the drag instead of lagging until the pad echoes it back.
		const s = this.activeSnapshot?.sensors[sensorIndex];
		if (s && s.threshold > 0)
			patch.releaseThreshold = clamp01(v * (s.releaseThreshold / s.threshold));
		this.#patch(sensorIndex, patch);
	}

	setReleaseThreshold(sensorIndex: number, value: number) {
		// Release can never exceed the press threshold (hysteresis would break); the
		// server enforces this too. Cap against the most current threshold we have.
		const s = this.activeSnapshot?.sensors[sensorIndex];
		// Nor go below the server's floor (a release near 0 can leave a button stuck).
		const cap = this.pending[sensorIndex]?.threshold ?? s?.threshold ?? 1;
		const minRelease = MIN_RELEASE_COUNTS / (this.device?.maxSensorValue ?? 1024);
		this.#patch(sensorIndex, {
			releaseThreshold: clamp01(Math.min(Math.max(value, minRelease), cap))
		});
	}

	/** Set the raw digipot gain byte (0..255). */
	setGain(sensorIndex: number, byte: number) {
		this.#patch(sensorIndex, { resistorValue: clampByte(byte) });
	}

	/** Map a sensor to a button (0 = unmapped/disabled, else 1-based). */
	setButton(sensorIndex: number, button: number) {
		this.#patch(sensorIndex, { button: Math.max(0, Math.round(button)) });
	}

	// ---- Device-level config (sent directly, snapshot echoes back) ----

	/** Renames the pad; the server moves its stored profiles along. */
	setName(name: string) {
		this.#sendPad({ name });
	}

	/** Names a button for display; '' clears it (back to its number). */
	setButtonName(button: number, name: string) {
		this.#sendPad({ buttonName: { button, name } });
	}

	/** The game side whose player the game puts on this pad: 1, 2, or 0 for none. */
	setSide(side: number) {
		this.#sendPad({ side });
	}

	/** Release mode: 0 none, 2 per-sensor. */
	setReleaseMode(mode: number) {
		this.#sendPad({ releaseMode: mode });
	}

	/**
	 * Set threshold = live value + offset (percent points) across mapped sensors.
	 * Re-reads each sensor's current live value as the baseline on every call, so
	 * the pad should be at rest when this runs. When `overwriteRelease` is true the
	 * release threshold is set equal to the new threshold; otherwise only the
	 * threshold is written. All patches flush together in one `{sensors:[...]}` send.
	 */
	calibrateThresholds(offsetPct: number, overwriteRelease: boolean) {
		const snap = this.activeSnapshot;
		if (!snap) return;
		const offset = offsetPct / 100;
		snap.sensors.forEach((s, i) => {
			if (s.button <= 0) return; // mapped sensors only
			const threshold = clamp01(s.value + offset);
			if (overwriteRelease)
				this.#patch(i, { threshold, releaseThreshold: threshold }); // release == press
			else this.#patch(i, { threshold }); // threshold only
		});
		this.commit();
	}

	#scheduleSend() {
		if (this.#sendTimer) return;
		this.#sendTimer = setTimeout(() => {
			this.#sendTimer = null;
			this.#flush();
		}, SEND_THROTTLE_MS);
	}

	#flush() {
		if (Object.keys(this.#unsent).length === 0) return;
		const snap = this.activeSnapshot;
		// Positional array: {} for sensors without new edits. Each patch is a HID
		// round-trip on the server, so already-sent edits are not repeated.
		const sent =
			!!snap &&
			!!this.pad &&
			!!this.conn?.send({
				pad: this.pad,
				sensors: snap.sensors.map((_, i) => this.#unsent[i] ?? {})
			});
		if (!sent) {
			// Pad stale or socket down: retry until it's back (or the edits are
			// dropped by a pad/profile change), keeping the overlay up meanwhile.
			const now = Date.now();
			for (const k of Object.keys(this.#unsent)) this.#pendingAt[Number(k)] = now;
			this.#scheduleSend();
			return;
		}
		this.#unsent = {};
	}

	/** Clear optimistic values the server has caught up to. Call each snapshot. */
	reconcile() {
		const snap = this.activeSnapshot;
		if (!snap) return;
		let changed = false;
		const next = { ...this.pending };
		const now = Date.now();
		for (const k of Object.keys(next)) {
			const i = Number(k);
			const s = snap.sensors[i];
			if (!s || now - (this.#pendingAt[i] ?? 0) > PENDING_TTL_MS) {
				delete next[i];
				changed = true;
				continue;
			}
			const patch: SensorPatch = { ...next[i] };
			const before = Object.keys(patch).length;
			if (patch.threshold !== undefined && Math.abs(s.threshold - patch.threshold) < EPS)
				delete patch.threshold;
			if (
				patch.releaseThreshold !== undefined &&
				Math.abs(s.releaseThreshold - patch.releaseThreshold) < EPS
			)
				delete patch.releaseThreshold;
			if (patch.resistorValue !== undefined && s.resistorValue === patch.resistorValue)
				delete patch.resistorValue;
			if (patch.button !== undefined && s.button === patch.button) delete patch.button;
			const after = Object.keys(patch).length;
			if (after === 0) {
				delete next[i];
				changed = true;
			} else if (after !== before) {
				next[i] = patch;
				changed = true;
			}
		}
		if (changed) this.pending = next;
	}
}

const OP_VERBS: Record<Op, string> = {
	loadProfile: 'load the profile',
	saveProfile: 'save the profile',
	importProfile: 'copy the profile',
	updateProfile: 'rename the profile',
	deleteProfile: 'delete the profile',
	selectPlayer: 'load the settings',
	setSide: 'set the side',
	rename: 'rename the pad',
	renameButton: 'name the button',
	setReleaseMode: 'change the release mode',
	configure: 'apply the change'
};

const OP_DONE: Record<Op, (name: string) => string> = {
	loadProfile: (n) => `Loaded ${n}`,
	saveProfile: (n) => `Saved ${n}`,
	importProfile: (n) => `Copied as ${n}`,
	updateProfile: (n) => `Renamed to ${n}`,
	deleteProfile: () => 'Profile deleted',
	selectPlayer: (n) => `Loaded ${n}`,
	setSide: () => 'Side set',
	rename: (n) => `Pad renamed to ${n}`,
	renameButton: (n) => (n ? `Button named ${n}` : 'Button name cleared'),
	setReleaseMode: () => 'Release mode changed',
	configure: () => 'Applied'
};

/** Mapped sensors grouped by button, sorted ascending; empty buttons skipped. */
export function groupByButton(mapped: MappedSensor[]): ButtonGroup[] {
	// Stable sort keeps snapshot-index order within a button.
	const groups: ButtonGroup[] = [];
	for (const m of [...mapped].sort((a, b) => a.sensor.button - b.sensor.button)) {
		const last = groups.at(-1);
		if (last?.button === m.sensor.button) last.sensors.push(m);
		else groups.push({ button: m.sensor.button, sensors: [m] });
	}
	return groups;
}

export const pads = new PadsStore();
