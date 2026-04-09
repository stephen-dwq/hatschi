/**
 * GBG helper for FoEProxy
 * Uses augmentation of FoEProxy.js and collected jsons associated with all GBG actions
 */

FoEproxy.addHandler('AnnouncementsService', 'fetchAllAnnouncements', (data, postData) => {
    // Closes the box when the player navigates back to the city
    HTML.CloseOpenBox('gbgMenu');
});

FoEproxy.addHandler('GuildBattlegroundService', 'getBattleground', (data, postData) => {
    // Don't create a new box while another one is still open
    if ($('#gbgMenu').length > 0) {
        return;
    }

    gbg.ShowMapDialog();
});

let gbg = {
    ShowMapDialog: () => {
        let body = [];

        HTML.AddCssFile('gbg');

        HTML.Box({
            'id': 'gbgMenu',
            'title': 'Battle',
            'auto_close': true,
            'dragdrop': true,
            'minimize': false
        });

        body.push(`<div class="gbg-section gbg-controls">
		<button class="btn" onclick="gbg.stop = false; gbg.lockDialog(); gbg.doEncounter(1);" id="oneHit">1 Hit</button>
		<button class="btn" onclick="gbg.stop = false; gbg.lockDialog(); gbg.doEncounter(10);" id="tenHit">10 Hits</button>
		<button class="btn" onclick="gbg.stop = false; gbg.lockDialog(); gbg.doEncounter(-1);" id="sectorKill">Sector</button>
		<button class="btn" onclick="gbg.stop = true;" id="stop" disabled>Stop</button>
		</div>`);
        body.push(`<div class="gbg-section dark-bg gbg-toggle">
		<label class="gbg-label">
			<input type="checkbox" class="game-cursor" id="race" ${gbg.racing ? "checked" : ""}>
			Full Take
		</label>
		<span id="raceTF" class="gbg-status">${gbg.racing ? 'Active' : 'Off'}</span>
		</div>`);
        body.push(`<div class="gbg-section dark-bg gbg-toggle">
		<label class="gbg-label">
			<input type="checkbox" class="game-cursor" id="demolish">
			Holding @180
		</label>
		<span id="holdingTF" class="gbg-status">${gbg.holding ? 'Active' : 'Off'}</span>
		</div>`);
        body.push(`<div class="gbg-section dark-bg gbg-slider-container">
		<label class="gbg-label">Attack Speed</label>
		<input type="range" min="0.25" max="1" step="0.05" value="${gbg.atkspdmod}" id="atkspd">
		<span id="atkMult" class="gbg-value">Multiplier: ${gbg.atkspdmod}</span>
		</div>`);
        body.push(`<div class="gbg-section dark-bg gbg-stats">
		<span>Target: <strong id="currTgt" class="gbg-value">${gbg.currentTarget}</strong></span>
		<span>Won: <strong id="battleWon" class="gbg-value">${gbg.battleInSession}</strong></span>
		<span>Lost: <strong id="battleLst" class="gbg-value">${gbg.losses}</strong></span>
		</div>`);
        body.push(`<div class="gbg-section dark-bg gbg-stats">
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

        $('#gbgMenuBody').html(body);
        document.querySelector("#atkspd").oninput = function () {
            gbg.atkspdmod = this.value;
            gbg.refreshDialog();
        };
        document.querySelector("#race").oninput = function () {
            gbg.racing = this.checked;
            gbg.refreshDialog();
        };
        document.querySelector("#demolish").oninput = function () {
            gbg.holding = this.checked;
            gbg.refreshDialog();
        };
    },

    lockDialog: () => {
        document.getElementById("oneHit").disabled = true;
        document.getElementById("tenHit").disabled = true;
        document.getElementById("sectorKill").disabled = true;
        document.getElementById("stop").disabled = false;
        gbg.refreshDialog();
    },

    unlockDialog: () => {
        document.getElementById("oneHit").disabled = false;
        document.getElementById("tenHit").disabled = false;
        document.getElementById("sectorKill").disabled = false;
        document.getElementById("stop").disabled = true;
        gbg.refreshDialog();
    },

    refreshDialog: () => {
        document.getElementById("raceTF").innerHTML = gbg.racing ? 'Active' : 'Off';
        document.getElementById("holdingTF").innerHTML = gbg.holding ? 'Active' : 'Off';
        document.getElementById("atkMult").innerHTML = `Multiplier: ${gbg.atkspdmod}`;
        document.getElementById("currTgt").innerHTML = `${gbg.currentTarget}`;
        document.getElementById("battleWon").innerHTML = `${gbg.battleInSession}`;
        document.getElementById("battleLst").innerHTML = `${gbg.losses}`;
        document.getElementById("attr").innerHTML = `${gbg.attritionGained}`;
        document.getElementById("dead").innerHTML = `${gbg.dead}`;
        document.getElementById("silver").innerHTML = `${gbg.silverCoins}`;
        document.getElementById("gold").innerHTML = `${gbg.goldCoins}`;
        document.getElementById("plat").innerHTML = `${gbg.platinumCoins}`;
    },

    racing: false,
    holding: false,
    atkspdmod: 1,
    diamonds: 0,
    fp: 0,
    losses: 0,
    battleInSession: 0,
    won: false,
    currentTarget: null,
    stop: false,
    templateId: null,
    template: null,
    units: [null, null, null, null, null, null, null, null],
    dead: 0,
    battlesWon: null,
    era: null,
    currentParticipantId: null,
    waveCount: null,
    attritionGained: 0,
    attritionStart: null,
    goldCoins: 0,
    platinumCoins: 0,
    silverCoins: 0,

    doEncounter: (n) => {
        gbg.atkStep1(n);
    },

    atkStep1: (n) => {
        gbg.refreshDialog();

        if (gbg.stop) {
            gbg.currentTarget = null;
        }

        if (0 == n) {
            gbg.unlockDialog();
            alert("Job Finished");
            return;
        }

        if (gbg.losses == 3) {
            gbg.unlockDialog();
            alert("Too many losses");
            gbg.losses = 0;
            return;
        }

        if (null == gbg.currentTarget) {
            gbg.stop = false;
            gbg.unlockDialog();
            alert("Retarget");
            return;
        }

        FoEproxy.sendRequest(gbg.reqData.step1Req(gbg.currentTarget), function () {
            gbg.atkStep2(n);
        });
    },

    atkStep2: (n) => {
        FoEproxy.sendRequest(gbg.reqData.step2Req(gbg.currentTarget), function () {
            setTimeout(gbg.setPreset, (350 + Math.ceil(Math.random() * 250)) * gbg.atkspdmod, n);
        });
    },

    setPreset: (n) => {
        if (gbg.template == null || gbg.templateId == null) {
            gbg.unlockDialog();
            alert("NO TEMPLATE");
            throw '';
        }

        if (gbg.units.includes(null)) {
            gbg.unlockDialog();
            alert("NO UNITS");
            throw '';
        }

        FoEproxy.sendRequest(gbg.reqData.setPresetReq(gbg.templateId, gbg.template), function () {
            gbg.armyRefill(n);
        });
    },

    armyRefill: (n) => {
        if (gbg.units.includes(null)) {
            gbg.unlockDialog();
            alert("NO UNITS");
            throw '';
        }

        FoEproxy.sendRequest(gbg.reqData.armyRefillReq(gbg.units), function () {
            gbg.atkStep3(n);
        });
    },

    atkStep3: (n) => {
        if (gbg.waveCount == null) {
            gbg.unlockDialog();
            alert("WAVECOUNT NULL");
            throw '';
        }

        FoEproxy.sendRequest(gbg.reqData.step3Req(gbg.currentTarget), function () {
            if (gbg.waveCount == 2 && gbg.won) {
                setTimeout(gbg.atkStep4, (250 + Math.ceil(Math.random() * 150)) * gbg.atkspdmod, n);
            } else {
                gbg.battleInSession += gbg.won;
                gbg.losses += (!gbg.won);
                gbg.losses *= (!gbg.won);
                gbg.waveCount = null;
                gbg.won = false;
                gbg.units = [null, null, null, null, null, null, null, null];
                setTimeout(gbg.doEncounter, (400 + Math.ceil(Math.random() * 200)) * gbg.atkspdmod, n - 1);
            }
        });
    },

    atkStep4: (n) => {
        if (gbg.battlesWon == null) {
            gbg.unlockDialog();
            alert("BATTLESWON NULL");
            throw '';
        }

        if (gbg.era == null) {
            gbg.unlockDialog();
            alert("ERA NULL");
            throw '';
        }

        FoEproxy.sendRequest(gbg.reqData.step4Req(gbg.currentTarget, gbg.battlesWon, gbg.era), function () {
            gbg.battleInSession += gbg.won;
            gbg.losses += (!gbg.won);
            gbg.losses *= (!gbg.won);
            gbg.waveCount = null;
            gbg.won = false;
            gbg.units = [null, null, null, null, null, null, null, null];
            setTimeout(gbg.doEncounter, (400 + Math.ceil(Math.random() * 200)) * gbg.atkspdmod, n - 1);
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
};

/*
Grabs guild id
 */
FoEproxy.addHandler('GuildBattlegroundService', 'getBattleground', (data, postData) => {
    gbg.currentParticipantId = data.responseData.currentParticipantId;
});

/*
Gets ID of province being attacked, and the number of waves in battle.
 */
FoEproxy.addHandler('BattlefieldService', 'getArmyPreview', (data, postData) => {
    if ($('#gbgMenu').length <= 0) return;
    gbg.currentTarget = postData[0].requestData[0].provinceId;
    gbg.waveCount = data.responseData.length;
});

/*
Grabs template and templateId.
Continues using units with 10 HP, replaces rest with full HP
Mimics "Refresh Units" button.
 */
FoEproxy.addHandler('ArmyUnitManagementService', 'getArmyInfo', (data, postData) => {
    if ($('#gbgMenu').length <= 0) return;
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
            if (unit.unitIds.length < 16) {
                alert("LOW UNITS");
                throw '';
            }
        }
        if (unit.is_attacking) {
            live++;
            if (unit.currentHitpoints == 10) {
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

    gbg.dead += (8 - live);
    gbg.units = returnUnits.slice(0, 8);
});

/*
Checks if previous battle was won
 */
FoEproxy.addHandler('BattlefieldService', 'startByBattleType', (data, postData) => {
    if ($('#gbgMenu').length <= 0) return;
    gbg.battlesWon = data.responseData.battleType.battlesWon;
    gbg.won = (data.responseData.state.winnerBit === 1);
    gbg.era = data.responseData.battleType.era;
});

/*
Increments GBG coin rewards
 */
FoEproxy.addHandler('RewardService', 'collectReward', (data, postData) => {
    if ($('#gbgMenu').length <= 0) return;
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
Stop attacking when hand is put up.
hand - ignore
target - focus
 */
FoEproxy.addWsHandler('GuildBattlegroundSignalsService', 'updateSignal', (data, postData) => {
    if ((data.responseData.provinceId == gbg.currentTarget || (gbg.currentTarget == 0 && data.responseData.provinceId == undefined)) && "ignore" == data.responseData.signal) {
        gbg.stop = true;
    }
});

/*
Stop attacking when approaching demolish danger.
 */
FoEproxy.addWsHandler('GuildBattlegroundService', 'getProvinces', (data, postData) => {
    if ((data.responseData[0].id == gbg.currentTarget || (gbg.currentTarget == 0 && data.responseData[0].id == undefined))) {
        if (data.responseData[0].lockedUntil != undefined) {
            gbg.stop = true;
            return;
        }

        attackers = data.responseData[0].conquestProgress;
        for (let attacker of attackers) {
            if (gbg.currentParticipantId == attacker.participantId) {
                if (!gbg.holding && attacker.maxProgress - attacker.progress <= (25 * !gbg.racing)) {
                    gbg.stop = true;
                    return;
                } else if (gbg.holding && !(attacker.progress <= 180 || gbg.racing)) {
                    gbg.stop = true;
                    return;
                }
            }
        }
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