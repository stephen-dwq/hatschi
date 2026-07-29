/**
 * Heroic Endeavor (Historical Allies) helper for FoEProxy
 *
 * Automates three of the five "allies" questlines offered by Bert:
 *   ReplayableSeason_Allies_Fight_a  - Defeat Enemy Armies (Attacking)
 *   ReplayableSeason_Allies_Fight_b  - Defeat Enemy Armies (Defending)
 *   ReplayableSeason_Allies_Pay_b    - Pay Medals
 *
 * Negotiations (Negotiation_a) and Forge Point payments (Pay_a) are deliberately
 * left alone. Quests from other chains that are already sitting in `collectReward`
 * when a run starts are never collected, only reported - the only quests this works
 * are its own, and it sends the single advanceQuest that closes each one out.
 *
 * The one exception is the Milestone counter (ReplayableSeason_Allies_Milestone).
 * It has no task of its own, but it stops counting while it sits uncollected, so a
 * ready milestone is advanced with a bare advanceQuest ahead of any other work. It
 * is matched on season type, not id, so Milestone 1 -> 2 -> 3 all work.
 *
 * Wire sequence per fight quest (mirrors the game client):
 *   getArmyPreview -> getArmyInfo -> saveTemplate -> updatePools
 *   -> startByBattleType -> advanceQuest -> getUpdates
 * Per pay quest:
 *   paySuccessCondition -> advanceQuest
 *
 * `advanceQuest` is a *claim* call: winning the battle only moves the quest to
 * `collectReward`, and the response to the claim carries the reward, the fresh
 * quest list and the successor quest. The trailing getUpdates on the fight cycle
 * re-reads that list the way the client does.
 *
 * Attacking and defending quests use the exact same request shapes and the same
 * *attacking* unit pool - in a defence battle the player's units still come back
 * flagged is_attacking on teamFlag 1, only the enemy preview's fightType and the
 * UI wording differ. So both fight chains run down one code path here.
 *
 * The client skips saveTemplate/updatePools when the player has not touched their
 * army, which means it can fight with damaged units. This always sends them, so
 * every battle starts at full health.
 */

let heroic = {

    CHAINS: {
        'ReplayableSeason_Allies_Fight_a': { key: 'attack', label: 'Attack', kind: 'fight' },
        'ReplayableSeason_Allies_Fight_b': { key: 'defend', label: 'Defend', kind: 'fight' },
        'ReplayableSeason_Allies_Pay_b': { key: 'medals', label: 'Medals', kind: 'pay' }
    },

    MILESTONE_TYPE: 'ReplayableSeason_Allies_Milestone',
    SCROLL_RESOURCE: 'historical_allies_train_manual_1',
    MAX_HP: 10,
    ARMY_SLOTS: 8,
    MAX_LOSSES: 3,
    MAX_REPEATS: 4,

    // --- persisted settings -------------------------------------------------
    enabled: { attack: true, defend: true, medals: false },
    medalCap: 50000,
    speed: 1,
    autoOpen: true,

    // --- run state ----------------------------------------------------------
    active: false,
    busy: false,
    dismissed: false,
    lastError: null,
    step: null,

    quests: [],
    seasons: {},
    scrollsStart: null,
    scrolls: null,
    consecutiveLosses: 0,
    lastTaskKey: null,
    repeats: 0,
    stats: { completed: 0, won: 0, lost: 0, milestones: 0, medalsSpent: 0 },

    army: { templateId: null, template: null, units: null, defending: [], arena: [] },


    /* ------------------------------------------------------------------ *
     * Settings
     * ------------------------------------------------------------------ */

    loadSettings: () => {
        let stored = null;
        try {
            stored = JSON.parse(localStorage.getItem('HeroicSettings'));
        } catch (e) {
            stored = null;
        }
        if (!stored) return;

        if (stored.enabled) Object.assign(heroic.enabled, stored.enabled);
        if (typeof stored.medalCap === 'number') heroic.medalCap = stored.medalCap;
        if (typeof stored.speed === 'number') heroic.speed = stored.speed;
        if (typeof stored.autoOpen === 'boolean') heroic.autoOpen = stored.autoOpen;
    },

    saveSettings: () => {
        localStorage.setItem('HeroicSettings', JSON.stringify({
            enabled: heroic.enabled,
            medalCap: heroic.medalCap,
            speed: heroic.speed,
            autoOpen: heroic.autoOpen
        }));
    },


    /* ------------------------------------------------------------------ *
     * Request builders
     *
     * requestId is a placeholder - FoEproxy rewrites it with the running
     * globalID before the request leaves the browser.
     * ------------------------------------------------------------------ */

    battleType: (questId, conditionId) => ({
        __class__: 'QuestBattleType',
        attackerPlayerId: 0,
        defenderPlayerId: 0,
        type: 'quest_battle',
        currentWaveId: 0,
        totalWaves: 0,
        questId: questId,
        conditionId: conditionId,
        armyId: 0,
        questType: 'quest'
    }),

    armyContext: (questId, conditionId) => ({
        __class__: 'QuestArmyContext',
        battleType: 'quest_battle',
        questId: questId,
        conditionId: conditionId,
        questType: 'quest'
    }),

    request: (requestClass, requestMethod, requestData) => JSON.stringify([{
        __class__: 'ServerRequest',
        requestData: requestData,
        requestClass: requestClass,
        requestMethod: requestMethod,
        requestId: 1
    }]),

    req: {
        getArmyPreview: (q, c) => heroic.request('BattlefieldService', 'getArmyPreview', [heroic.battleType(q, c)]),
        getArmyInfo: (q, c) => heroic.request('ArmyUnitManagementService', 'getArmyInfo', [heroic.armyContext(q, c)]),
        startBattle: (q, c) => heroic.request('BattlefieldService', 'startByBattleType', [heroic.battleType(q, c), true]),
        advanceQuest: (q) => heroic.request('QuestService', 'advanceQuest', [q]),
        paySuccessCondition: (q, c) => heroic.request('QuestService', 'paySuccessCondition', [q, c, 'quest']),
        getUpdates: () => heroic.request('QuestService', 'getUpdates', []),

        saveTemplate: (id, unitTypeIds) => heroic.request('ArmyUnitManagementService', 'saveTemplate', [{
            __class__: 'ArmyPoolTemplate',
            id: id,
            unitTypeIds: unitTypeIds
        }]),

        // All three pools are always sent. The defending / arena pools are echoed
        // back from getArmyInfo so an existing city defence is never wiped.
        updatePools: (units, defending, arena, q, c) => heroic.request('ArmyUnitManagementService', 'updatePools', [
            [
                { __class__: 'ArmyPool', units: units, type: 'attacking' },
                { __class__: 'ArmyPool', units: defending, type: 'defending' },
                { __class__: 'ArmyPool', units: arena, type: 'arena_defending' }
            ],
            heroic.armyContext(q, c)
        ])
    },


    /* ------------------------------------------------------------------ *
     * Transport
     *
     * FoEproxy.sendRequest assigns `onload` before send() registers the
     * proxy's own load listener, so this callback runs *before* any
     * FoEproxy.addHandler observer. The response is therefore parsed here
     * rather than read out of handler side-effects.
     * ------------------------------------------------------------------ */

    send: (payload, onDone) => {
        FoEproxy.sendRequest(payload, function () {
            let messages;

            try {
                messages = JSON.parse(this.responseText);
            } catch (e) {
                heroic.abort('BAD RESPONSE');
                return;
            }

            if (!Array.isArray(messages)) {
                heroic.abort('BAD RESPONSE');
                return;
            }

            const error = messages.find(m => m.__class__ === 'ServerError' || m.requestClass === 'ErrorService');
            if (error) {
                heroic.abort('SERVER ERROR: ' + (error.responseData?.message || error.requestMethod || 'unknown'));
                return;
            }

            heroic.absorb(messages);
            onDone(messages);
        });
    },

    find: (messages, requestClass, requestMethod) => {
        const hit = messages.find(m => m.requestClass === requestClass && m.requestMethod === requestMethod);
        return hit ? hit.responseData : null;
    },

    // Pick up the state the server volunteers on every response.
    absorb: (messages) => {
        const quests = heroic.find(messages, 'QuestService', 'getUpdates');
        if (Array.isArray(quests)) heroic.quests = quests;

        const season = heroic.find(messages, 'QuestService', 'getSeasonUpdate');
        if (season && season.type) heroic.seasons[season.type] = season;

        const bag = heroic.find(messages, 'ResourceService', 'getPlayerResourceBag');
        const resources = bag?.resources?.resources;
        if (resources && typeof resources[heroic.SCROLL_RESOURCE] === 'number') {
            heroic.scrolls = resources[heroic.SCROLL_RESOURCE];
            if (heroic.scrollsStart === null) heroic.scrollsStart = heroic.scrolls;
        }
    },

    delay: (fn, base) => {
        setTimeout(fn, (base + Math.ceil(Math.random() * base * 0.5)) * heroic.speed);
    },


    /* ------------------------------------------------------------------ *
     * Quest inspection
     * ------------------------------------------------------------------ */

    chainOf: (quest) => heroic.CHAINS[quest.type] || null,

    isChainEnabled: (quest) => {
        const chain = heroic.chainOf(quest);
        return chain ? heroic.enabled[chain.key] === true : false;
    },

    // The condition this tool acts on: the fight or the payment.
    actionCondition: (quest) => {
        const conditions = quest.successConditions || [];
        return conditions.find(c => (c.flags || []).includes('fight_condition'))
            || conditions.find(c => (c.flags || []).includes('pay_condition'))
            || conditions[0]
            || null;
    },

    payCost: (quest) => {
        const condition = heroic.actionCondition(quest);
        const payload = (condition?.payload || []).find(p => p.type === 'pay');
        return payload?.cost?.resources || null;
    },

    payTotal: (cost) => Object.values(cost || {}).reduce((sum, amount) => sum + amount, 0),

    withinCap: (quest) => {
        const cost = heroic.payCost(quest);
        return cost ? heroic.payTotal(cost) <= heroic.medalCap : false;
    },

    // Quests of ours that are finished but uncollected. Nothing is done about
    // these - collecting is the player's call - but a chain sitting here cannot
    // hand out its next quest, so they are surfaced in the dialog.
    blocked: () => heroic.quests.filter(q => q.state === 'collectReward' && heroic.isChainEnabled(q)),

    // Quests this tool is configured to work on.
    actionable: () => heroic.quests.filter(q => {
        if (q.state !== 'accepted' || !heroic.isChainEnabled(q)) return false;

        const chain = heroic.chainOf(q);
        if (chain.kind !== 'pay') return true;

        return heroic.withinCap(q);
    }),

    // The milestone counter, once its progress has topped out. Matched on season
    // type rather than id so it keeps working as Milestone 1 gives way to 2, 3, ...
    milestoneReady: () => heroic.quests.find(
        q => q.type === heroic.MILESTONE_TYPE && q.state === 'collectReward'
    ) || null,

    // A ready milestone goes first: until it is advanced the counter stops moving,
    // so every quest completed ahead of it is progress thrown away.
    nextTask: () => {
        const milestone = heroic.milestoneReady();
        if (milestone) return { type: 'milestone', quest: milestone };

        const work = heroic.actionable();
        if (work.length === 0) return null;

        return { type: heroic.chainOf(work[0]).kind, quest: work[0] };
    },


    /* ------------------------------------------------------------------ *
     * Army selection
     *
     * getArmyInfo returns ArmyUnitStack entries (a pool of fresh unitIds per
     * type) plus individual ArmyUnit entries carrying is_attacking /
     * currentHitpoints. Survivors at full health are reused, the rest of the
     * template is filled from the stacks - the same rule the game's
     * "Refresh Units" button applies.
     * ------------------------------------------------------------------ */

    readArmy: (armyInfo) => {
        const template = armyInfo?.templates?.[0];
        if (!template || !Array.isArray(template.unitTypeIds)) return 'NO TEMPLATE';

        const stacks = {};
        const survivors = [];
        const defending = [];
        const arena = [];

        for (let unit of armyInfo.units || []) {
            if (unit.__class__ === 'ArmyUnitStack') {
                stacks[unit.unitTypeId] = (unit.unitIds || []).slice();
            }
            if (unit.is_attacking && unit.currentHitpoints === heroic.MAX_HP) {
                survivors.push(unit);
            }
            if (unit.is_defending) defending.push(unit.unitId);
            if (unit.isArenaDefending) arena.push(unit.unitId);
        }

        const slots = template.unitTypeIds.slice(0, heroic.ARMY_SLOTS);
        const units = [];

        for (let unitTypeId of slots) {
            const reusable = survivors.findIndex(u => u.unitTypeId === unitTypeId);

            if (reusable !== -1) {
                units.push(survivors[reusable].unitId);
                survivors.splice(reusable, 1);
                continue;
            }

            const pool = stacks[unitTypeId];
            if (!pool || pool.length === 0) return 'LOW UNITS';

            units.push(pool.pop());
        }

        if (units.length < slots.length) return 'LOW UNITS';

        heroic.army = {
            templateId: template.id,
            template: template.unitTypeIds,
            units: units,
            defending: defending,
            arena: arena
        };

        return null;
    },


    /* ------------------------------------------------------------------ *
     * Runner
     * ------------------------------------------------------------------ */

    setActive: (active) => {
        heroic.active = active;
        heroic.lastError = null;

        if (active) {
            heroic.consecutiveLosses = 0;
            heroic.lastTaskKey = null;
            heroic.repeats = 0;
            if (heroic.scrollsStart === null) heroic.scrollsStart = heroic.scrolls;
            heroic.pump();
        } else {
            heroic.step = null;
        }

        heroic.refreshDialog();
    },

    abort: (message) => {
        heroic.active = false;
        heroic.busy = false;
        heroic.step = null;
        heroic.lastError = message;
        heroic.refreshDialog();
    },

    finish: (message) => {
        heroic.active = false;
        heroic.busy = false;
        heroic.step = null;
        heroic.lastError = message || null;
        heroic.refreshDialog();
    },

    // Advance the queue when idle.
    pump: () => {
        if (!heroic.active || heroic.busy) return;

        const task = heroic.nextTask();
        if (!task) {
            heroic.finish('Nothing left to do');
            return;
        }

        // If the server keeps handing back the same task, something is wrong that
        // retrying will not fix - stop rather than hammer it. Fight retries after a
        // loss are bounded separately by MAX_LOSSES, which is lower than this.
        const key = `${task.type}:${task.quest.id}`;
        if (key === heroic.lastTaskKey) {
            if (++heroic.repeats >= heroic.MAX_REPEATS) {
                heroic.abort(`Stuck on ${task.quest.title}`);
                return;
            }
        } else {
            heroic.lastTaskKey = key;
            heroic.repeats = 0;
        }

        heroic.busy = true;
        heroic.lastError = null;

        if (task.type === 'milestone') heroic.runMilestone(task.quest);
        else if (task.type === 'pay') heroic.runPay(task.quest);
        else heroic.runFight(task.quest);
    },

    taskDone: () => {
        heroic.busy = false;
        heroic.step = null;
        heroic.refreshDialog();

        if (heroic.active) heroic.delay(heroic.pump, 400);
    },

    setStep: (step) => {
        heroic.step = step;
        heroic.refreshDialog();
    },


    /* --- milestone ------------------------------------------------------- */

    // A single advanceQuest and nothing else - the milestone has no task of its
    // own to perform, it is purely a counter over the other questlines.
    runMilestone: (quest) => {
        heroic.setStep(`Advancing ${quest.title}`);

        heroic.send(heroic.req.advanceQuest(quest.id), () => {
            heroic.stats.milestones++;
            heroic.taskDone();
        });
    },


    /* --- pay ------------------------------------------------------------ */

    runPay: (quest) => {
        const condition = heroic.actionCondition(quest);
        const cost = heroic.payCost(quest);

        if (!condition || !cost) {
            heroic.abort('NO PAY CONDITION');
            return;
        }

        if (!heroic.withinCap(quest)) {
            heroic.finish(`Cost ${heroic.payTotal(cost).toLocaleString()} exceeds cap`);
            return;
        }

        heroic.setStep(`Paying ${quest.title}`);

        heroic.send(heroic.req.paySuccessCondition(quest.id, condition.id), () => {
            heroic.stats.medalsSpent += cost.medals || 0;

            heroic.delay(() => {
                heroic.send(heroic.req.advanceQuest(quest.id), () => {
                    heroic.stats.completed++;
                    heroic.taskDone();
                });
            }, 300);
        });
    },


    /* --- fight ---------------------------------------------------------- */

    runFight: (quest) => {
        const condition = heroic.actionCondition(quest);
        if (!condition) {
            heroic.abort('NO FIGHT CONDITION');
            return;
        }

        const questId = quest.id;
        const conditionId = condition.id;

        heroic.setStep(`Scouting ${quest.title}`);

        heroic.send(heroic.req.getArmyPreview(questId, conditionId), () => {
            heroic.delay(() => heroic.fightArmyInfo(quest, questId, conditionId), 300);
        });
    },

    fightArmyInfo: (quest, questId, conditionId) => {
        heroic.setStep(`Selecting units for ${quest.title}`);

        heroic.send(heroic.req.getArmyInfo(questId, conditionId), (messages) => {
            const armyInfo = heroic.find(messages, 'ArmyUnitManagementService', 'getArmyInfo');
            const problem = heroic.readArmy(armyInfo);

            if (problem) {
                heroic.abort(problem);
                return;
            }

            heroic.delay(() => heroic.fightSaveTemplate(quest, questId, conditionId), 300);
        });
    },

    fightSaveTemplate: (quest, questId, conditionId) => {
        heroic.send(heroic.req.saveTemplate(heroic.army.templateId, heroic.army.template), () => {
            heroic.fightUpdatePools(quest, questId, conditionId);
        });
    },

    fightUpdatePools: (quest, questId, conditionId) => {
        const payload = heroic.req.updatePools(
            heroic.army.units,
            heroic.army.defending,
            heroic.army.arena,
            questId,
            conditionId
        );

        heroic.send(payload, () => {
            heroic.delay(() => heroic.fightStart(quest, questId, conditionId), 350);
        });
    },

    fightStart: (quest, questId, conditionId) => {
        heroic.setStep(`Fighting ${quest.title}`);

        heroic.send(heroic.req.startBattle(questId, conditionId), (messages) => {
            const battle = heroic.find(messages, 'BattlefieldService', 'startByBattleType');
            const won = battle?.state?.winnerBit === 1;

            if (!won) {
                heroic.stats.lost++;
                heroic.consecutiveLosses++;

                if (heroic.consecutiveLosses >= heroic.MAX_LOSSES) {
                    heroic.abort('Too many losses');
                    return;
                }

                heroic.taskDone();
                return;
            }

            heroic.stats.won++;
            heroic.consecutiveLosses = 0;

            heroic.delay(() => heroic.fightAdvance(quest, questId), 400);
        });
    },

    fightAdvance: (quest, questId) => {
        heroic.setStep(`Completing ${quest.title}`);

        heroic.send(heroic.req.advanceQuest(questId), () => {
            heroic.stats.completed++;
            heroic.delay(() => heroic.fightRefresh(), 250);
        });
    },

    // Closes the fight cycle the way the game client does. The quest list also
    // rides back on advanceQuest, so this is a confirmation read rather than the
    // only source of truth - the run continues on whichever arrives last.
    fightRefresh: () => {
        heroic.send(heroic.req.getUpdates(), () => {
            heroic.taskDone();
        });
    },


    /* ------------------------------------------------------------------ *
     * Passive observation of the game client's own traffic
     * ------------------------------------------------------------------ */

    // A quest list piggybacks on most city actions, but the quest UI asks for one
    // on its own. Only the standalone form is treated as "the player is looking at
    // quests", so the box does not pop up during unrelated play.
    isStandaloneQuestFetch: (postData) => Array.isArray(postData) && postData.some(
        p => p.requestClass === 'QuestService' && p.requestMethod === 'getUpdates'
    ),

    onQuestUpdates: (quests, postData) => {
        if (!Array.isArray(quests)) return;
        if (heroic.busy) return; // our own sequence owns the state while running

        heroic.quests = quests;

        if ($('#heroicMenu').length > 0) {
            heroic.refreshDialog();
            return;
        }

        if (heroic.autoOpen
            && !heroic.dismissed
            && heroic.isStandaloneQuestFetch(postData)
            && heroic.nextTask()) {
            heroic.ShowDialog();
        }
    },


    /* ------------------------------------------------------------------ *
     * UI
     * ------------------------------------------------------------------ */

    ShowDialog: () => {
        HTML.AddCssFile('heroic');

        HTML.Box({
            id: 'heroicMenu',
            title: 'Heroic Endeavor',
            auto_close: true,
            dragdrop: true,
            minimize: false
        });

        $('#heroicMenuclose').on('click', () => { heroic.dismissed = true; });

        heroic.refreshDialog();
    },

    statusLabel: () => {
        if (heroic.busy) return 'Working';
        if (heroic.active) return 'Active';
        return 'Idle';
    },

    seasonLabel: (type) => {
        const season = heroic.seasons[type];
        return season ? `${season.progress}/${season.count}` : '–';
    },

    refreshDialog: () => {
        if ($('#heroicMenu').length === 0) return;

        const task = heroic.nextTask();
        const blocked = heroic.blocked();
        const work = heroic.actionable();
        const milestone = heroic.milestoneReady();
        const gained = (heroic.scrolls !== null && heroic.scrollsStart !== null)
            ? heroic.scrolls - heroic.scrollsStart
            : 0;

        let body = [];

        body.push(`<div class="heroic-section dark-bg heroic-toggle">
            <label class="heroic-label">
                <input type="checkbox" class="game-cursor" id="heroicActive"${heroic.active ? ' checked' : ''}>
                Bot active
            </label>
            <span id="heroicStatus" class="heroic-status">${heroic.statusLabel()}</span>
        </div>`);

        body.push(`<div class="heroic-section dark-bg">
            <span class="heroic-label">Questlines</span>
            ${Object.entries(heroic.CHAINS).map(([type, chain]) => `
                <label class="heroic-chain">
                    <input type="checkbox" class="game-cursor heroic-chain-toggle"
                        data-key="${chain.key}"${heroic.enabled[chain.key] ? ' checked' : ''}>
                    <span class="heroic-chain-label">${chain.label}</span>
                    <span class="heroic-value">${heroic.seasonLabel(type)}</span>
                </label>`).join('')}
        </div>`);

        body.push(`<div class="heroic-section dark-bg">
            <label class="heroic-label" for="heroicMedalCap">Max medals per quest</label>
            <input type="number" id="heroicMedalCap" class="heroic-input game-cursor"
                min="0" step="1000" value="${heroic.medalCap}">
        </div>`);

        body.push(`<div class="heroic-section dark-bg heroic-toggle">
            <label class="heroic-label">
                <input type="checkbox" class="game-cursor" id="heroicAutoOpen"${heroic.autoOpen ? ' checked' : ''}>
                Open automatically
            </label>
            <span class="heroic-status">${heroic.autoOpen ? 'On' : 'Off'}</span>
        </div>`);

        body.push(`<div class="heroic-section dark-bg heroic-slider-container">
            <label class="heroic-label">Action Speed</label>
            <input type="range" min="0.25" max="2" step="0.05" value="${heroic.speed}" id="heroicSpeed">
            <span id="heroicSpeedValue" class="heroic-value">Multiplier: ${heroic.speed}</span>
        </div>`);

        body.push(`<div class="heroic-section dark-bg">
            <span class="heroic-label">${heroic.busy ? 'Current step' : 'Next task'}</span>
            <span class="heroic-value">${heroic.step || heroic.describeTask(task)}</span>
        </div>`);

        body.push(`<div class="heroic-section dark-bg heroic-stats">
            <span>Done: <strong class="heroic-value">${heroic.stats.completed}</strong></span>
            <span>Milestones: <strong class="heroic-value">${heroic.stats.milestones}</strong></span>
            <span>Won: <strong class="heroic-value">${heroic.stats.won}</strong></span>
            <span>Lost: <strong class="heroic-value">${heroic.stats.lost}</strong></span>
        </div>`);

        body.push(`<div class="heroic-section dark-bg heroic-stats">
            <span>Scrolls: <strong class="heroic-value">+${gained}</strong></span>
            <span>Medals spent: <strong class="heroic-value">${heroic.stats.medalsSpent.toLocaleString()}</strong></span>
        </div>`);

        if (heroic.lastError) {
            body.push(`<div class="heroic-section dark-bg">
                <span class="heroic-label">Last message</span>
                <span class="heroic-value heroic-error">${heroic.lastError}</span>
            </div>`);
        }

        body.push(`<div class="heroic-section dark-bg">
            <span class="heroic-label">Queue (${work.length + (milestone ? 1 : 0)})</span>
            <div class="heroic-quest-list">${heroic.renderQueue(work, blocked, milestone)}</div>
        </div>`);

        $('#heroicMenuBody').html(body.join(''));

        document.querySelector('#heroicActive').oninput = function () {
            heroic.setActive(this.checked);
        };

        document.querySelectorAll('.heroic-chain-toggle').forEach((box) => {
            box.oninput = function () {
                heroic.enabled[this.dataset.key] = this.checked;
                heroic.saveSettings();
                heroic.refreshDialog();
                if (heroic.active) heroic.pump();
            };
        });

        document.querySelector('#heroicAutoOpen').oninput = function () {
            heroic.autoOpen = this.checked;
            heroic.saveSettings();
            heroic.refreshDialog();
        };

        document.querySelector('#heroicMedalCap').onchange = function () {
            const value = parseInt(this.value, 10);
            heroic.medalCap = isNaN(value) || value < 0 ? 0 : value;
            heroic.saveSettings();
            heroic.refreshDialog();
        };

        document.querySelector('#heroicSpeed').oninput = function () {
            heroic.speed = parseFloat(this.value);
            heroic.saveSettings();
            document.querySelector('#heroicSpeedValue').innerHTML = `Multiplier: ${heroic.speed}`;
        };
    },

    describeTask: (task) => {
        if (!task) return 'Nothing to do';
        if (task.type === 'milestone') return `Advance ${task.quest.title}`;
        if (task.type === 'pay') return `Pay ${task.quest.title}`;
        return `Fight ${task.quest.title}`;
    },

    // `blocked` rows are shown but never acted on - they are waiting on the player
    // to collect them in game, which is what releases the next quest in the chain.
    renderQueue: (work, blocked, milestone) => {
        const rows = (milestone ? [{ quest: milestone, tag: 'milestone' }] : [])
            .concat(work.map(q => ({ quest: q, tag: heroic.chainOf(q).kind })))
            .concat(blocked.map(q => ({ quest: q, tag: 'uncollected' })));

        if (rows.length === 0) {
            return '<div class="heroic-empty">Nothing queued</div>';
        }

        return rows.map(({ quest, tag }) => {
            const condition = heroic.actionCondition(quest);
            const cost = heroic.payCost(quest);
            const detail = cost
                ? Object.entries(cost).map(([r, a]) => `${a.toLocaleString()} ${r}`).join(', ')
                : (condition?.description || '');

            return `<div class="heroic-quest-item">
                <span class="heroic-quest-title">${quest.title}</span>
                <span class="heroic-tag heroic-tag-${tag}">${tag}</span>
                <span class="heroic-quest-detail">${detail}</span>
            </div>`;
        }).join('');
    }
};


/* ---------------------------------------------------------------------- *
 * FoEProxy wiring
 * ---------------------------------------------------------------------- */

heroic.loadSettings();

// Every quest action the client performs carries a fresh quest list.
FoEproxy.addHandler('QuestService', 'getUpdates', (data, postData) => {
    heroic.onQuestUpdates(data.responseData, postData);
});

// Season progress only ever arrives on an advanceQuest response.
FoEproxy.addHandler('QuestService', 'getSeasonUpdate', (data) => {
    const season = data.responseData;
    if (season && season.type) {
        heroic.seasons[season.type] = season;
        heroic.refreshDialog();
    }
});

FoEproxy.addHandler('ResourceService', 'getPlayerResourceBag', (data) => {
    const resources = data.responseData?.resources?.resources;
    if (!resources || typeof resources[heroic.SCROLL_RESOURCE] !== 'number') return;

    heroic.scrolls = resources[heroic.SCROLL_RESOURCE];
    if (heroic.scrollsStart === null) heroic.scrollsStart = heroic.scrolls;
});

// Returning to the city stops the run and closes the box.
FoEproxy.addHandler('AnnouncementsService', 'fetchAllAnnouncements', () => {
    if (heroic.active) heroic.finish('Stopped - left the city');
    heroic.dismissed = false;
    HTML.CloseOpenBox('heroicMenu');
});
