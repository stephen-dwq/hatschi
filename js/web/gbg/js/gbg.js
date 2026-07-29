/**
 * GBG helper for FoEProxy
 *
 * One service covering the whole battleground loop:
 *   - a live model of the map (`gbg.map`),
 *   - the fire-control layer that picks a province out of it,
 *   - the attack runner that fights the province, and
 *   - two dialogs: the control box, and an optional map box.
 *
 * The runner can be pointed by hand (click a province in game, then 1 / 10 / Sector)
 * or by the bot, which walks its own target queue. Both go down the same code path:
 * the bot only ever sets `currentTarget` and calls `doEncounter(-1)`.
 *
 * Wire sequence per battle (mirrors the game client):
 *   getArmyPreview -> getArmyInfo -> saveTemplate -> updatePools -> startByBattleType
 * A two-wave province sends a second startByBattleType carrying the won wave count.
 *
 * Fire control never attacks a province the guild has flagged `ignore`, and stops a
 * running job when that flag appears mid-attack or when the province reaches the stop
 * line (see `checkStopConditions`). Target selection is tiered:
 *   strict    - `focus` flagged provinces only
 *   nonstrict - focus at 20% attrition, then any other focus, then unflagged
 *               20%-attrition provinces still below the progress cap
 */

let gbg = {

    /* --- constants ------------------------------------------------------- */

    ARMY_SLOTS: 8,
    FULL_HP: 10,
    MIN_STACK: 16,
    MAX_LOSSES: 3,

    ATTRITION_CHANCE: 20,
    ATTRITION_PROGRESS_CAP: 90,
    NEAR_TAKE_MARGIN: 25,
    HOLDING_CAP: 90,

    // Problems retrying cannot fix - the bot shuts itself off rather than
    // walk the queue burning the same failure on every province.
    FATAL: ['NO TEMPLATE', 'NO UNITS', 'LOW UNITS', 'WAVECOUNT NULL', 'BATTLESWON NULL', 'ERA NULL'],

    TIER_LABELS: {
        'focus-20': 'focus+20%',
        'focus-high': 'focus>20%',
        'focus': 'focus',
        'attrition': '20%'
    },

    GROUP_LABELS: {
        target: 'Targets',
        attackable: 'Attackable',
        locked: 'Locked',
        far: 'Open elsewhere',
        ours: 'Ours'
    },

    /* --- settings -------------------------------------------------------- */

    racing: false,              // push a province all the way to the take
    holding: false,             // stop at 90% progress instead
    strictFireControl: true,
    atkspdmod: 1,

    /* --- run state ------------------------------------------------------- */

    active: false,              // bot on
    attacking: false,           // a job is in flight
    jobId: 0,                   // bumped per job, so an aborted chain cannot resume
    stop: false,                // stop the running job at the next battle
    step: null,                 // what the runner is doing right now
    lastError: null,            // last thing worth telling the player

    currentTarget: null,
    currentParticipantId: null,
    mapTimer: null,             // redraws the map box so lock countdowns tick

    templateId: null,
    template: null,
    units: [null, null, null, null, null, null, null, null],
    waveCount: null,
    battlesWon: null,
    era: null,
    won: false,

    losses: 0,
    battleInSession: 0,
    dead: 0,
    attritionGained: 0,
    attritionStart: null,
    goldCoins: 0,
    platinumCoins: 0,
    silverCoins: 0,


    /* ------------------------------------------------------------------ *
     * Live map model
     *
     * A standalone picture of the battleground, built from the getBattleground
     * snapshot and kept current from the websocket frames the game pushes.
     *
     * This is deliberately not shared with guildfights.js. `ProvinceMap.Provinces`
     * is a *rendering* structure: it does not exist until the player opens the
     * province map box, and `applyProvinceUpdate` only merges websocket patches
     * into it while that box is on screen. Targeting cannot depend on a window
     * being open, so the state is kept here. The one thing borrowed from
     * ProvinceMap is `ProvinceData()`, a constant layout table.
     * ------------------------------------------------------------------ */

    map: {
        ready: false,
        revision: 0,            // bumped on every change
        byId: {},
        ids: [],                // layout order
        participants: {},       // participantId -> guild name

        now: () => Math.floor(Date.now() / 1000),

        // Keyed off GuildFights.MapData, which the guildfights handler fills in
        // from the same response that triggers our reset.
        layout: () => {
            try {
                return ProvinceMap?.ProvinceData?.() || [];
            } catch (e) {
                return [];
            }
        },

        // The first sector comes back without an id.
        snapshotIndex: (battleground) => {
            const index = {};

            (battleground?.map?.provinces || []).forEach((province, position) => {
                index[province?.id ?? position] = province;
            });

            return index;
        },

        participantName: (participantId) => gbg.map.participants[participantId] || null,

        reset: (battleground) => {
            const layout = gbg.map.layout();
            if (layout.length === 0) return false;

            const snapshot = gbg.map.snapshotIndex(battleground);
            const participants = battleground?.battlegroundParticipants || [];

            gbg.map.participants = {};
            for (let participant of participants) {
                gbg.map.participants[participant.participantId] = participant?.clan?.name || null;
            }

            gbg.map.byId = {};
            gbg.map.ids = [];

            for (let entry of layout) {
                const province = snapshot[entry.id] || {};

                gbg.map.byId[entry.id] = {
                    id: entry.id,
                    name: entry.name,
                    short: entry.short,
                    title: province.title,
                    connections: entry.connections || [],
                    ownerId: province.ownerId,
                    ownerName: gbg.map.participantName(province.ownerId),
                    lockedUntil: province.lockedUntil,
                    conquestProgress: province.conquestProgress || [],
                    gainAttritionChance: province.gainAttritionChance,
                    battleType: province.isAttackBattleType ? 'attack' : 'defence',
                    signal: null
                };

                gbg.map.ids.push(entry.id);
            }

            // The player's own signals ride along on the snapshot.
            const player = participants.find(p => p.participantId === battleground?.currentParticipantId);
            for (let signal of player?.signals || []) {
                const province = gbg.map.byId[signal.provinceId ?? 0];
                if (province) province.signal = signal.signal;
            }

            gbg.map.ready = true;
            gbg.map.revision++;
            return true;
        },

        // Patches are whole province objects rather than deltas: a key that is
        // absent has been cleared. Mirrors ProvinceMap.RefreshSector.
        applyPatch: (patch) => {
            if (!patch) return false;

            const province = gbg.map.byId[patch.id ?? 0];
            if (!province) return false;

            if ('conquestProgress' in patch) province.conquestProgress = patch.conquestProgress || [];

            if ('lockedUntil' in patch) province.lockedUntil = patch.lockedUntil;
            else delete province.lockedUntil;

            if ('gainAttritionChance' in patch) province.gainAttritionChance = patch.gainAttritionChance;
            else delete province.gainAttritionChance;

            if ('isAttackBattleType' in patch) province.battleType = patch.isAttackBattleType ? 'attack' : 'defence';

            if (patch.ownerId !== undefined && patch.ownerId !== province.ownerId) {
                province.ownerId = patch.ownerId;
                province.ownerName = gbg.map.participantName(patch.ownerId);
            }

            gbg.map.revision++;
            return true;
        },

        applySignal: (provinceId, signal) => {
            const province = gbg.map.byId[provinceId ?? 0];
            if (!province) return false;

            province.signal = signal || null;
            gbg.map.revision++;
            return true;
        },

        get: (id) => gbg.map.byId[id] ?? null,

        list: () => gbg.map.ids.map(id => gbg.map.byId[id]),

        /* --- derived state (computed, never cached - adjacency and progress
               both move during a round) --- */

        isOpen: (province) => !(province.lockedUntil > gbg.map.now()),

        unlockIn: (province) => province.lockedUntil ? Math.max(0, province.lockedUntil - gbg.map.now()) : 0,

        isOwn: (province) => province.ownerId !== undefined && province.ownerId === gbg.playerGuildId(),

        isNeutral: (province) => province.ownerId === undefined,

        adjacentToPlayer: (province) => (province.connections || []).some(id => {
            const neighbour = gbg.map.byId[id];
            return neighbour && neighbour.ownerId === gbg.playerGuildId();
        }),

        playerEntry: (province) =>
            (province.conquestProgress || []).find(e => e.participantId === gbg.playerGuildId()) || null,

        maxProgress: (province) => province.conquestProgress?.[0]?.maxProgress ?? null
    },


    /* ------------------------------------------------------------------ *
     * Fire control
     * ------------------------------------------------------------------ */

    // getBattleground carries it directly; GuildFights holds it between visits.
    playerGuildId: () => gbg.currentParticipantId ?? GuildFights.MapData?.currentParticipantId,

    compactProvinceName: (name) => {
        if (!name) return null;
        const match = name.match(/^([^:]+):\s*(\S+)/);
        return match ? `${match[1]}:${match[2]}` : name;
    },

    getProvinceLabel: (province) => {
        if (!province) return 'None';
        return province.short
            || gbg.compactProvinceName(province.name || province.title)
            || `${province.id}`;
    },

    getProvinceLabelById: (id) => {
        const province = gbg.map.get(id);
        return province ? gbg.getProvinceLabel(province) : `${id}`;
    },

    getPlayerProgress: (province) => gbg.map.playerEntry(province)?.progress ?? 0,

    isOwnedByPlayer: (province) => gbg.map.isOwn(province),

    isIgnored: (province) => province.signal === 'ignore',

    // The runner halts a job once a province is all but taken (or past the hold
    // line) - see checkStopConditions. Fire control has to agree, otherwise the
    // queue would hand that same province straight back and the guard would
    // spend the run fighting the targeting.
    isPastStopLine: (province) => {
        if (gbg.racing) return false;

        const entry = gbg.map.playerEntry(province);
        if (!entry) return false;

        if (gbg.holding) return entry.progress > gbg.HOLDING_CAP;

        return entry.maxProgress - entry.progress <= gbg.NEAR_TAKE_MARGIN;
    },

    // Unlocked, not ours, and touching something of ours.
    getAttackableProvinces: () => gbg.map.list().filter(province =>
        !gbg.map.isOwn(province)
        && gbg.map.isOpen(province)
        && gbg.map.adjacentToPlayer(province)
    ),

    isFocusAttackTarget: (province) => {
        if (gbg.isIgnored(province)) return false;
        if (gbg.isOwnedByPlayer(province)) return false;
        if (gbg.isPastStopLine(province)) return false;
        return province.signal === 'focus';
    },

    isFocusWithAttrition20: (province) => {
        return gbg.isFocusAttackTarget(province)
            && province.gainAttritionChance === gbg.ATTRITION_CHANCE;
    },

    isFocusWithAttritionAbove20: (province) => {
        return gbg.isFocusAttackTarget(province)
            && province.gainAttritionChance > gbg.ATTRITION_CHANCE;
    },

    isFocusTier2: (province) => {
        return gbg.isFocusAttackTarget(province)
            && !gbg.isFocusWithAttrition20(province);
    },

    isAttritionFallbackTarget: (province) => {
        if (gbg.isIgnored(province)) return false;
        if (gbg.isOwnedByPlayer(province)) return false;
        if (gbg.isPastStopLine(province)) return false;
        if (province.gainAttritionChance !== gbg.ATTRITION_CHANCE) return false;
        return gbg.getPlayerProgress(province) < gbg.ATTRITION_PROGRESS_CAP;
    },

    getTargetProvinces: () => {
        const attackable = gbg.getAttackableProvinces();

        if (gbg.strictFireControl) {
            return attackable.filter(gbg.isFocusAttackTarget);
        }

        const tier1 = attackable.filter(gbg.isFocusWithAttrition20);
        const tier1Ids = new Set(tier1.map(p => p.id));

        const tier2 = attackable.filter(p => gbg.isFocusTier2(p) && !tier1Ids.has(p.id));
        const focusIds = new Set([...tier1, ...tier2].map(p => p.id));

        const tier3 = attackable.filter(p => !focusIds.has(p.id) && gbg.isAttritionFallbackTarget(p));

        return tier1.concat(tier2, tier3);
    },

    selectTarget: () => {
        const targets = gbg.getTargetProvinces();
        return targets.length > 0 ? targets[0] : null;
    },

    getTargetTier: (province) => {
        if (!gbg.map.isOpen(province) || gbg.map.isOwn(province) || !gbg.map.adjacentToPlayer(province)) return null;

        if (gbg.strictFireControl) {
            return gbg.isFocusAttackTarget(province) ? 'focus' : null;
        }

        if (gbg.isFocusWithAttrition20(province)) return 'focus-20';
        if (gbg.isFocusTier2(province)) {
            return gbg.isFocusWithAttritionAbove20(province) ? 'focus-high' : 'focus';
        }
        if (gbg.isAttritionFallbackTarget(province)) return 'attrition';
        return null;
    },

    // Which bucket a province falls in for the map box. Every province lands in
    // exactly one, checked in this order.
    classify: (province, targetIds) => {
        if (gbg.map.isOwn(province)) return 'ours';
        if (targetIds.has(province.id)) return 'target';
        if (!gbg.map.isOpen(province)) return 'locked';
        if (!gbg.map.adjacentToPlayer(province)) return 'far';
        return 'attackable';
    },

    // The whole map bucketed for display. Targets keep queue order - that is the
    // order they would actually be fought in - everything else stays in map order.
    groupProvinces: () => {
        const targets = gbg.getTargetProvinces();
        const targetIds = new Set(targets.map(p => p.id));
        const groups = { target: targets, attackable: [], locked: [], far: [], ours: [] };

        for (let province of gbg.map.list()) {
            const group = gbg.classify(province, targetIds);
            if (group !== 'target') groups[group].push(province);
        }

        return groups;
    },


    /* ------------------------------------------------------------------ *
     * Bot
     * ------------------------------------------------------------------ */

    setActive: (active) => {
        if (!active) gbg.abort();

        gbg.active = active;
        gbg.lastError = gbg.map.ready ? null : 'Waiting for the battleground';

        if (active) gbg.tryAdvanceQueue();

        gbg.refreshUI();
    },

    abort: () => {
        gbg.stop = true;
        gbg.currentTarget = null;
        gbg.attacking = false;
        gbg.step = null;
        gbg.jobId++;
    },

    // Every frame is a chance for a better target to appear, so the queue is
    // re-read rather than cached.
    onMapUpdate: () => {
        gbg.refreshUI();
        if (gbg.active && !gbg.attacking) gbg.tryAdvanceQueue();
    },

    // A batch of province patches straight off the wire. The model is updated
    // before anything reads it, so targeting always sees the current frame.
    onMapFrame: (patches) => {
        if (!gbg.map.ready && GuildFights?.MapData) gbg.map.reset(GuildFights.MapData);

        for (let patch of patches || []) {
            gbg.map.applyPatch(patch);
        }

        gbg.checkStopConditions();
        gbg.onMapUpdate();
    },

    // Reasons to put down a province mid-job. The runner acts on `stop` at the
    // start of the next battle, so a job never breaks off half-fought.
    checkStopConditions: () => {
        if (gbg.currentTarget == null) return;

        const province = gbg.map.get(gbg.currentTarget);
        if (!province) return;

        if (!gbg.map.isOpen(province)
            || gbg.isIgnored(province)
            || gbg.isPastStopLine(province)) {
            gbg.stop = true;
        }
    },

    tryAdvanceQueue: () => {
        if (!gbg.active || gbg.attacking) return;

        const target = gbg.selectTarget();
        if (!target) return;

        gbg.currentTarget = target.id;
        gbg.doEncounter(-1);
    },


    /* ------------------------------------------------------------------ *
     * Job lifecycle
     *
     * Manual runs and bot runs share this: the only difference is who set
     * `currentTarget` and whether the queue is walked once the job ends.
     * ------------------------------------------------------------------ */

    isEngaged: () => $('#gbgMenu').length > 0 || gbg.attacking,

    doEncounter: (n) => {
        gbg.attacking = true;
        gbg.stop = false;
        gbg.lastError = null;
        gbg.atkStep1(n, ++gbg.jobId);
    },

    // A job that has been aborted may still have a request in flight; its
    // callback must not walk on top of whatever started in the meantime.
    isStale: (job) => job !== gbg.jobId,

    requestStop: () => {
        gbg.stop = true;
        gbg.refreshUI();
    },

    // A manual run keeps its province so the buttons can be pressed again without
    // re-clicking the map; the bot drops it and re-reads the queue.
    finishJob: () => {
        gbg.attacking = false;
        gbg.step = null;
        gbg.jobId++;

        if (gbg.active) {
            gbg.currentTarget = null;
            gbg.refreshUI();
            gbg.tryAdvanceQueue();
            return;
        }

        gbg.lastError = 'Job finished';
        gbg.refreshUI();
    },

    abortJob: (message) => {
        gbg.attacking = false;
        gbg.step = null;
        gbg.jobId++;
        gbg.lastError = message;

        if (!gbg.active) {
            gbg.refreshUI();
            return;
        }

        gbg.currentTarget = null;

        if (gbg.FATAL.includes(message)) {
            gbg.active = false;
            gbg.refreshUI();
            return;
        }

        gbg.refreshUI();
        gbg.tryAdvanceQueue();
    },

    setStep: (step) => {
        gbg.step = step;
        gbg.refreshUI();
    },

    delay: (fn, base, ...args) => {
        setTimeout(fn, (base + Math.ceil(Math.random() * base * 0.5)) * gbg.atkspdmod, ...args);
    },

    // Reset the per-battle state and queue the next encounter of the job.
    nextEncounter: (n, job) => {
        gbg.battleInSession += gbg.won;
        gbg.losses += (!gbg.won);
        gbg.losses *= (!gbg.won);
        gbg.waveCount = null;
        gbg.won = false;
        gbg.units = [null, null, null, null, null, null, null, null];

        gbg.delay(gbg.atkStep1, 400, n - 1, job);
    },


    /* ------------------------------------------------------------------ *
     * Attack runner
     * ------------------------------------------------------------------ */

    atkStep1: (n, job) => {
        if (gbg.isStale(job)) return;

        if (gbg.stop) gbg.currentTarget = null;

        if (0 == n) {
            gbg.finishJob();
            return;
        }

        if (gbg.losses == gbg.MAX_LOSSES) {
            gbg.losses = 0;
            gbg.abortJob('Too many losses');
            return;
        }

        if (null == gbg.currentTarget) {
            gbg.stop = false;
            gbg.abortJob('Retarget');
            return;
        }

        gbg.setStep(`Scouting ${gbg.getProvinceLabelById(gbg.currentTarget)}`);

        FoEproxy.sendRequest(gbg.reqData.step1Req(gbg.currentTarget), function () {
            gbg.atkStep2(n, job);
        });
    },

    atkStep2: (n, job) => {
        if (gbg.isStale(job)) return;

        gbg.setStep(`Selecting units for ${gbg.getProvinceLabelById(gbg.currentTarget)}`);

        FoEproxy.sendRequest(gbg.reqData.step2Req(gbg.currentTarget), function () {
            gbg.delay(gbg.setPreset, 350, n, job);
        });
    },

    setPreset: (n, job) => {
        if (gbg.isStale(job)) return;

        if (gbg.template == null || gbg.templateId == null) {
            gbg.abortJob('NO TEMPLATE');
            return;
        }

        if (gbg.units.includes(null)) {
            gbg.abortJob('NO UNITS');
            return;
        }

        FoEproxy.sendRequest(gbg.reqData.setPresetReq(gbg.templateId, gbg.template), function () {
            gbg.armyRefill(n, job);
        });
    },

    armyRefill: (n, job) => {
        if (gbg.isStale(job)) return;

        if (gbg.units.includes(null)) {
            gbg.abortJob('NO UNITS');
            return;
        }

        FoEproxy.sendRequest(gbg.reqData.armyRefillReq(gbg.units), function () {
            gbg.atkStep3(n, job);
        });
    },

    atkStep3: (n, job) => {
        if (gbg.isStale(job)) return;

        if (gbg.waveCount == null) {
            gbg.abortJob('WAVECOUNT NULL');
            return;
        }

        gbg.setStep(`Fighting ${gbg.getProvinceLabelById(gbg.currentTarget)}`);

        FoEproxy.sendRequest(gbg.reqData.step3Req(gbg.currentTarget), function () {
            if (gbg.waveCount == 2 && gbg.won) {
                gbg.delay(gbg.atkStep4, 250, n, job);
            } else {
                gbg.nextEncounter(n, job);
            }
        });
    },

    // Second wave. Only reached when the first one was won.
    atkStep4: (n, job) => {
        if (gbg.isStale(job)) return;

        if (gbg.battlesWon == null) {
            gbg.abortJob('BATTLESWON NULL');
            return;
        }

        if (gbg.era == null) {
            gbg.abortJob('ERA NULL');
            return;
        }

        gbg.setStep(`Fighting ${gbg.getProvinceLabelById(gbg.currentTarget)} (wave 2)`);

        FoEproxy.sendRequest(gbg.reqData.step4Req(gbg.currentTarget, gbg.battlesWon, gbg.era), function () {
            gbg.nextEncounter(n, job);
        });
    },

    reqData: {
        step1Req: (id) => {
            return JSON.stringify([{ "__class__": "ServerRequest", "requestData": [{ "__class__": "BattlegroundBattleType", "attackerPlayerId": 0, "defenderPlayerId": 0, "type": "battleground", "currentWaveId": 0, "totalWaves": 0, "provinceId": id, "battlesWon": 0 }], "requestClass": "BattlefieldService", "requestMethod": "getArmyPreview", "requestId": 67 }]);
        },
        step2Req: (id) => {
            return JSON.stringify([{ "__class__": "ServerRequest", "requestData": [{ "__class__": "BattlegroundArmyContext", "battleType": "battleground", "provinceId": id }], "requestClass": "ArmyUnitManagementService", "requestMethod": "getArmyInfo", "requestId": 67 }]);
        },
        step3Req: (id) => {
            return JSON.stringify([{ "__class__": "ServerRequest", "requestData": [{ "__class__": "BattlegroundBattleType", "attackerPlayerId": 0, "defenderPlayerId": 0, "type": "battleground", "currentWaveId": 0, "totalWaves": 0, "provinceId": id, "battlesWon": 0 }, true], "requestClass": "BattlefieldService", "requestMethod": "startByBattleType", "requestId": 67 }]);
        },
        step4Req: (id, won, era) => {
            return JSON.stringify([{ "__class__": "ServerRequest", "requestData": [{ "__class__": "BattlegroundBattleType", "attackerPlayerId": 0, "defenderPlayerId": 0, "era": era, "type": "battleground", "currentWaveId": 0, "totalWaves": 2, "provinceId": id, "battlesWon": won }, true], "requestClass": "BattlefieldService", "requestMethod": "startByBattleType", "requestId": 67 }]);
        },
        setPresetReq: (templateId, template) => {
            return JSON.stringify([{ "__class__": "ServerRequest", "requestData": [{ "__class__": "ArmyPoolTemplate", "id": templateId, "unitTypeIds": template }], "requestClass": "ArmyUnitManagementService", "requestMethod": "saveTemplate", "requestId": 67 }]);
        },
        armyRefillReq: (units) => {
            return JSON.stringify([{ "__class__": "ServerRequest", "requestData": [[{ "__class__": "ArmyPool", "units": units, "type": "attacking" }, { "__class__": "ArmyPool", "units": [], "type": "defending" }, { "__class__": "ArmyPool", "units": [], "type": "arena_defending" }], { "__class__": "ArmyContext", "battleType": "battleground" }], "requestClass": "ArmyUnitManagementService", "requestMethod": "updatePools", "requestId": 67 }]);
        },
    },


    /* ------------------------------------------------------------------ *
     * Shared UI helpers
     * ------------------------------------------------------------------ */

    refreshUI: () => {
        gbg.refreshDialog();
        gbg.refreshMapDialog();
    },

    statusLabel: () => {
        if (gbg.attacking) return 'Attacking';
        if (gbg.active) return 'Active';
        return 'Idle';
    },

    // What the runner is pointed at: the province it is fighting, or the one it
    // would pick up next.
    displayTarget: () => {
        if (gbg.currentTarget != null) return gbg.getProvinceLabelById(gbg.currentTarget);

        const next = gbg.selectTarget();
        return next ? gbg.getProvinceLabel(next) : 'None';
    },

    formatDuration: (seconds) => {
        if (seconds <= 0) return '0:00';

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const rest = seconds % 60;
        const pad = (value) => `${value}`.padStart(2, '0');

        return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
    },

    // Progress reads as "ours / needed", with the leader shown when someone else
    // is further along on the same province.
    progressText: (province) => {
        if ((province.conquestProgress || []).length === 0) return '—';

        const mine = gbg.getPlayerProgress(province);
        const max = gbg.map.maxProgress(province);
        const leader = (province.conquestProgress || [])
            .filter(e => e.participantId !== gbg.playerGuildId())
            .sort((a, b) => b.progress - a.progress)[0];

        let text = max ? `${mine}/${max}` : `${mine}`;
        if (leader) text += ` · rival ${leader.progress}`;

        return text;
    },

    ownerText: (province) => {
        if (gbg.map.isOwn(province)) return 'ours';
        if (gbg.map.isNeutral(province)) return 'neutral';
        return province.ownerName || `#${province.ownerId}`;
    },

    stateText: (province) => {
        if (!gbg.map.isOpen(province)) return `locked ${gbg.formatDuration(gbg.map.unlockIn(province))}`;
        if (gbg.map.isOwn(province)) return 'ours';
        return 'open';
    },


    /* ------------------------------------------------------------------ *
     * Control dialog
     * ------------------------------------------------------------------ */

    ShowDialog: () => {
        HTML.AddCssFile('gbg');

        HTML.Box({
            'id': 'gbgMenu',
            'title': 'Battle',
            'auto_close': true,
            'dragdrop': true,
            'minimize': false
        });

        gbg.refreshDialog();
    },

    refreshDialog: () => {
        if ($('#gbgMenu').length === 0) return;

        const targets = gbg.getTargetProvinces();
        const manualDisabled = (gbg.active || gbg.attacking) ? ' disabled' : '';

        let body = [];

        body.push(`<div class="gbg-section gbg-controls">
            <button class="btn" onclick="gbg.doEncounter(1);" id="oneHit"${manualDisabled}>1 Hit</button>
            <button class="btn" onclick="gbg.doEncounter(10);" id="tenHit"${manualDisabled}>10 Hits</button>
            <button class="btn" onclick="gbg.doEncounter(-1);" id="sectorKill"${manualDisabled}>Sector</button>
            <button class="btn" onclick="gbg.requestStop();" id="stop"${gbg.attacking ? '' : ' disabled'}>Stop</button>
        </div>`);

        body.push(`<div class="gbg-section dark-bg gbg-toggle">
            <label class="gbg-label">
                <input type="checkbox" class="game-cursor" id="gbgActive"${gbg.active ? ' checked' : ''}>
                Bot active
            </label>
            <span id="gbgStatus" class="gbg-status">${gbg.statusLabel()}</span>
        </div>`);

        body.push(`<div class="gbg-section dark-bg gbg-toggle">
            <label class="gbg-label">
                <input type="checkbox" class="game-cursor" id="gbgStrict"${gbg.strictFireControl ? ' checked' : ''}>
                Strict fire-control
            </label>
            <span id="gbgMode" class="gbg-status">${gbg.strictFireControl ? 'Strict' : 'Nonstrict'}</span>
        </div>`);

        body.push(`<div class="gbg-section dark-bg gbg-toggle">
            <label class="gbg-label">
                <input type="checkbox" class="game-cursor" id="race"${gbg.racing ? ' checked' : ''}>
                Full Take
            </label>
            <span id="raceTF" class="gbg-status">${gbg.racing ? 'Active' : 'Off'}</span>
        </div>`);

        body.push(`<div class="gbg-section dark-bg gbg-toggle">
            <label class="gbg-label">
                <input type="checkbox" class="game-cursor" id="demolish"${gbg.holding ? ' checked' : ''}>
                Holding @90
            </label>
            <span id="holdingTF" class="gbg-status">${gbg.holding ? 'Active' : 'Off'}</span>
        </div>`);

        body.push(`<div class="gbg-section dark-bg gbg-slider-container">
            <label class="gbg-label">Attack Speed</label>
            <input type="range" min="0.25" max="1" step="0.05" value="${gbg.atkspdmod}" id="atkspd">
            <span id="atkMult" class="gbg-value">Multiplier: ${gbg.atkspdmod}</span>
        </div>`);

        body.push(`<div class="gbg-section dark-bg">
            <span class="gbg-label">${gbg.attacking ? 'Current step' : 'Next target'}</span>
            <span id="gbgStep" class="gbg-value">${gbg.step || gbg.displayTarget()}</span>
        </div>`);

        if (gbg.lastError) {
            body.push(`<div class="gbg-section dark-bg">
                <span class="gbg-label">Last message</span>
                <span class="gbg-value gbg-error">${gbg.lastError}</span>
            </div>`);
        }

        body.push(`<div class="gbg-section dark-bg gbg-stats">
            <span>Won: <strong id="battleWon" class="gbg-value">${gbg.battleInSession}</strong></span>
            <span>Lost: <strong id="battleLst" class="gbg-value">${gbg.losses}</strong></span>
            <span>Attrition: <strong id="attr" class="gbg-value">${gbg.attritionGained}</strong></span>
            <span>Dead: <strong id="dead" class="gbg-value">${gbg.dead}</strong></span>
        </div>`);

        body.push(`<div class="gbg-section dark-bg">
            <label class="gbg-label">Rewards Earned</label>
            <div class="gbg-reward-row">
                ${srcLinks.icons("gbg_silver_coin")}
                <span id="silver" class="gbg-value">${gbg.silverCoins}</span>
            </div>
            <div class="gbg-reward-row">
                ${srcLinks.icons("gbg_gold_coin")}
                <span id="gold" class="gbg-value">${gbg.goldCoins}</span>
            </div>
            <div class="gbg-reward-row">
                ${srcLinks.icons("gbg_platinum_coin")}
                <span id="plat" class="gbg-value">${gbg.platinumCoins}</span>
            </div>
        </div>`);

        body.push(`<div class="gbg-section dark-bg">
            <div class="gbg-queue-head">
                <span class="gbg-label">Queue (${targets.length})</span>
                <button class="btn gbg-mini-btn" onclick="gbg.toggleMapDialog();">Map</button>
            </div>
            <div id="gbgTargetList" class="gbg-province-list">${gbg.renderTargetList(targets)}</div>
        </div>`);

        $('#gbgMenuBody').html(body.join(''));

        document.querySelector('#gbgActive').oninput = function () {
            gbg.setActive(this.checked);
        };

        document.querySelector('#gbgStrict').oninput = function () {
            gbg.strictFireControl = this.checked;
            gbg.refreshUI();
            if (gbg.active && !gbg.attacking) gbg.tryAdvanceQueue();
        };

        document.querySelector('#race').oninput = function () {
            gbg.racing = this.checked;
            gbg.refreshUI();
        };

        document.querySelector('#demolish').oninput = function () {
            gbg.holding = this.checked;
            gbg.refreshUI();
        };

        // Only the label is updated while dragging - a full re-render would drop
        // the slider out from under the pointer.
        document.querySelector('#atkspd').oninput = function () {
            gbg.atkspdmod = this.value;
            document.querySelector('#atkMult').innerHTML = `Multiplier: ${gbg.atkspdmod}`;
        };
    },

    renderTargetList: (targets) => {
        if (!gbg.map.ready) {
            return '<div class="gbg-empty">Waiting for the battleground</div>';
        }

        if (targets.length === 0) {
            return '<div class="gbg-empty">No targets in queue</div>';
        }

        return targets.map((province) => {
            const tier = gbg.getTargetTier(province);
            const tierLabel = gbg.TIER_LABELS[tier] || tier;
            const signal = province.signal || 'none';
            const attrition = province.gainAttritionChance ?? '—';
            const progress = gbg.getPlayerProgress(province);
            const current = gbg.currentTarget === province.id ? ' gbg-province-current' : '';

            return `<div class="gbg-province-item${current}">
                <span class="gbg-province-id">${gbg.getProvinceLabel(province)}</span>
                <span class="gbg-tier gbg-tier-${tier}">${tierLabel}</span>
                <span class="gbg-signal">${signal} · ${attrition}% · ${progress}</span>
            </div>`;
        }).join('');
    },


    /* ------------------------------------------------------------------ *
     * Map dialog
     *
     * Read-only view of the model. Opened on demand from the control box;
     * everything it shows is derived, so it costs nothing when closed.
     * ------------------------------------------------------------------ */

    toggleMapDialog: () => {
        if ($('#gbgMapMenu').length > 0) {
            HTML.CloseOpenBox('gbgMapMenu');
            gbg.stopMapTimer();
            return;
        }

        gbg.ShowMapDialog();
    },

    ShowMapDialog: () => {
        HTML.AddCssFile('gbg');

        HTML.Box({
            'id': 'gbgMapMenu',
            'title': 'GBG Map',
            'auto_close': true,
            'dragdrop': true,
            'minimize': true,
            'resize': true
        });

        gbg.startMapTimer();
        gbg.refreshMapDialog();
    },

    // Frames are the main driver, but lock countdowns have to tick on their own.
    startMapTimer: () => {
        if (gbg.mapTimer) return;

        gbg.mapTimer = setInterval(() => {
            if ($('#gbgMapMenu').length === 0) {
                gbg.stopMapTimer();
                return;
            }

            gbg.refreshMapDialog();
        }, 1000);
    },

    stopMapTimer: () => {
        clearInterval(gbg.mapTimer);
        gbg.mapTimer = null;
    },

    refreshMapDialog: () => {
        if ($('#gbgMapMenu').length === 0) return;

        if (!gbg.map.ready) {
            $('#gbgMapMenuBody').html(`<div class="gbg-section dark-bg">
                <span class="gbg-empty">Waiting for the battleground</span>
            </div>`);
            return;
        }

        const groups = gbg.groupProvinces();

        let body = [];

        body.push(gbg.renderOperationPanel(groups.target));

        body.push(`<div class="gbg-section dark-bg gbg-map-counts">
            <span>Targets: <strong class="gbg-value">${groups.target.length}</strong></span>
            <span>Attackable: <strong class="gbg-value">${groups.attackable.length}</strong></span>
            <span>Locked: <strong class="gbg-value">${groups.locked.length}</strong></span>
            <span>Ours: <strong class="gbg-value">${groups.ours.length}</strong></span>
        </div>`);

        for (let group of ['target', 'attackable', 'locked', 'far', 'ours']) {
            const provinces = groups[group];
            if (provinces.length === 0) continue;

            body.push(`<div class="gbg-section dark-bg">
                <span class="gbg-label">${gbg.GROUP_LABELS[group]} (${provinces.length})</span>
                <div class="gbg-map-list">
                    ${provinces.map(p => gbg.renderMapRow(p, group)).join('')}
                </div>
            </div>`);
        }

        $('#gbgMapMenuBody').html(body.join(''));
    },

    // The province being fought, in full: what the runner is doing to it and
    // where it stands on the map.
    renderOperationPanel: (targets) => {
        const province = gbg.currentTarget != null ? gbg.map.get(gbg.currentTarget) : null;
        const next = province ? null : gbg.selectTarget();

        let detail;

        if (province) {
            detail = `${gbg.stateText(province)} · ${gbg.ownerText(province)}
                · ${gbg.progressText(province)}
                · ${province.gainAttritionChance ?? '—'}% attrition
                · signal ${province.signal || 'none'}`;
        } else if (next) {
            detail = `Next up: ${gbg.getProvinceLabel(next)} · ${gbg.progressText(next)}`;
        } else {
            detail = targets.length === 0 ? 'No province qualifies right now' : 'Idle';
        }

        return `<div class="gbg-section dark-bg gbg-map-operation">
            <div class="gbg-map-operation-head">
                <span class="gbg-map-operation-title">${province ? gbg.getProvinceLabel(province) : 'No target'}</span>
                <span class="gbg-status">${gbg.statusLabel()}</span>
            </div>
            <span class="gbg-value">${gbg.step || (gbg.active ? 'Waiting for a target' : 'Idle')}</span>
            <span class="gbg-map-operation-detail">${detail}</span>
        </div>`;
    },

    renderMapRow: (province, group) => {
        const tier = group === 'target' ? gbg.getTargetTier(province) : null;
        const current = gbg.currentTarget === province.id ? ' gbg-map-row-current' : '';
        const attrition = province.gainAttritionChance ?? '—';

        const badge = tier
            ? `<span class="gbg-tier gbg-tier-${tier}">${gbg.TIER_LABELS[tier] || tier}</span>`
            : `<span class="gbg-tier gbg-tier-${group}">${gbg.stateText(province)}</span>`;

        const signal = province.signal
            ? `<span class="gbg-map-signal gbg-map-signal-${province.signal}">${province.signal}</span>`
            : '';

        // The badge already says "ours", so the owner column would just repeat it.
        const owner = group === 'ours' ? '' : gbg.ownerText(province);

        return `<div class="gbg-map-row${current}">
            <span class="gbg-map-name">${gbg.getProvinceLabel(province)}</span>
            ${badge}
            ${signal}
            <span class="gbg-map-detail">${gbg.progressText(province)} · ${attrition}%</span>
            <span class="gbg-map-owner">${owner}</span>
        </div>`;
    }
};


/* ---------------------------------------------------------------------- *
 * FoEProxy wiring
 * ---------------------------------------------------------------------- */

/*
Leaving the battleground stops the run and closes both boxes.
 */
FoEproxy.addHandler('AnnouncementsService', 'fetchAllAnnouncements', () => {
    gbg.active = false;
    gbg.abort();
    gbg.stopMapTimer();
    HTML.CloseOpenBox('gbgMenu');
    HTML.CloseOpenBox('gbgMapMenu');
});

/*
Entering the battleground seeds the map model and opens the control box.
 */
FoEproxy.addHandler('GuildBattlegroundService', 'getBattleground', (data, postData) => {
    gbg.currentParticipantId = data.responseData.currentParticipantId;
    gbg.map.reset(data.responseData);

    // Don't create a new box while another one is still open
    if ($('#gbgMenu').length === 0) {
        gbg.ShowDialog();
        return;
    }

    gbg.refreshUI();
});

/*
Batched province updates: progress, locks, attrition, ownership.
 */
FoEproxy.addWsHandler('GuildBattlegroundService', 'getProvinces', (data, postData) => {
    gbg.onMapFrame(data.responseData);
});

/*
Single-province pushes arrive under other methods of the same service.
 */
FoEproxy.addWsHandler('GuildBattlegroundService', 'all', (data, postData) => {
    if (data.requestMethod === 'getProvinces') return;
    if (!data.responseData?.[0]) return;

    gbg.onMapFrame([data.responseData[0]]);
});

/*
Guild signals.
hand - ignore
target - focus
 */
FoEproxy.addWsHandler('GuildBattlegroundSignalsService', 'updateSignal', (data, postData) => {
    gbg.map.applySignal(data.responseData.provinceId, data.responseData.signal);
    gbg.checkStopConditions();
    gbg.onMapUpdate();
});

/*
Gets ID of province being attacked, and the number of waves in battle.
Also how a manual target is picked: clicking a province in game fires this.
 */
FoEproxy.addHandler('BattlefieldService', 'getArmyPreview', (data, postData) => {
    if (!gbg.isEngaged()) return;
    gbg.currentTarget = postData[0].requestData[0].provinceId;
    gbg.waveCount = data.responseData.length;
});

/*
Grabs template and templateId.
Continues using units with 10 HP, replaces rest with full HP
Mimics "Refresh Units" button.
 */
FoEproxy.addHandler('ArmyUnitManagementService', 'getArmyInfo', (data, postData) => {
    if (!gbg.isEngaged()) return;
    gbg.templateId = data.responseData.templates[0].id;
    gbg.template = data.responseData.templates[0].unitTypeIds;

    let returnUnits = [];
    let is_attacking = [];
    let unitIdsDict = {};
    let template_copy = structuredClone(gbg.template);

    let live = 0;

    for (let unit of data.responseData.units) {
        if (unit.__class__ == "ArmyUnitStack" && template_copy.includes(unit.unitTypeId)) {
            unitIdsDict[unit.unitTypeId] = unit.unitIds;
            if (unit.unitIds.length < gbg.MIN_STACK) {
                gbg.abortJob("LOW UNITS");
                return;
            }
        }
        if (unit.is_attacking) {
            live++;
            if (unit.currentHitpoints == gbg.FULL_HP) {
                is_attacking.push(unit);
            }
        }
    }

    while (template_copy.length != 0) {
        let currentId = template_copy[0];
        let found = false;

        for (var i = is_attacking.length - 1; i > -1; i--) {
            if (is_attacking[i].unitTypeId == currentId) {
                returnUnits.push(is_attacking[i].unitId);
                found = true;
                is_attacking.splice(i, 1);
                break;
            }
        }
        if (!found) {
            let unitAdd = unitIdsDict[currentId].pop();
            returnUnits.push(unitAdd);
            found = true;
        }
        template_copy.splice(0, 1);
    }

    gbg.dead += (gbg.ARMY_SLOTS - live);
    gbg.units = returnUnits.slice(0, gbg.ARMY_SLOTS);
});

/*
Checks if previous battle was won
 */
FoEproxy.addHandler('BattlefieldService', 'startByBattleType', (data, postData) => {
    if (!gbg.isEngaged()) return;
    gbg.battlesWon = data.responseData.battleType.battlesWon;
    gbg.won = (data.responseData.state.winnerBit === 1);
    gbg.era = data.responseData.battleType.era;
});

/*
Increments GBG coin rewards
 */
FoEproxy.addHandler('RewardService', 'collectReward', (data, postData) => {
    if (!gbg.isEngaged()) return;
    if (data.responseData[0][0].subType == "gbg_gold_coin") {
        gbg.goldCoins += data.responseData[0][0].amount || 1;
    }
    if (data.responseData[0][0].subType == "gbg_platinum_coin") {
        gbg.platinumCoins += data.responseData[0][0].amount || 1;
    }
    if (data.responseData[0][0].subType == "gbg_silver_coin") {
        gbg.silverCoins += data.responseData[0][0].amount || 1;
    }
});

/*
Grabs attrition data for player.
 */
FoEproxy.addHandler('GuildBattlegroundService', 'getPlayerParticipant', (data, postData) => {
    if (gbg.attritionStart == null) {
        gbg.attritionStart = data.responseData.attrition.level;
    } else {
        gbg.attritionGained = data.responseData.attrition.level - gbg.attritionStart;
    }
});
