/**
 * Finish Special Production helper for FoEProxy
 *
 * Loops one special-production building: aid it, rush it, collect it, then dump the
 * forge points that came out into a chosen Great Building.
 *
 * The building being harvested is not picked in this dialog - it is whichever one the
 * player last collected from in the city, which the pickupProduction handler picks up.
 * The Great Building on the other end is chosen in the dropdown.
 *
 * Wire sequence per cycle:
 *   useItem (aid) -> useItem (finish special) -> pickupProduction
 *   -> getConstruction -> contributeForgePoints
 * Each hop is preceded by a NoticeIndicatorService.remove, which is what the client
 * sends as the player clicks around, so the traffic keeps the shape of hand play.
 */

let fsp = {

    MIN_ITEMS: 25,          // stop before the kit / rush stacks run dry

    // --- run state ----------------------------------------------------------
    running: false,         // a loop is in flight
    stop: false,            // stop flag for automation loop
    step: null,             // what the loop is doing right now
    lastError: null,        // last thing worth telling the player

    collections: 0,         // num collections made this session
    fpSpent: 0,             // FP contributed this session

    // --- settings -----------------------------------------------------------
    ignoreBG: false,        // allow running without Blue Galaxy charges

    allGBs: null,           // array of all player GBs, built in Show()

    // metadata of current fp dump target
    currGB: null,           // map entity id of the target GB (was aoID)
    currFP: null,           // FP already invested in current level
    maxFP: null,            // FP required to level up
    currLvl: null,          // current level  (was lvl)
    currMaxLvl: null,       // max level      (was mx_lvl)

    singleAidKitID: null,   // inventory item id for self-aid kits (was aidID)
    finishSpecialID: null,  // inventory item id for finish-special-production (was fspID)

    player_id: null,        // owner of the target GB
    target_id: null,        // map entity id of the special-production building being harvested


    Show: () => {
        fsp.allGBs = [];
        for (let building of Object.values(MainParser.CityMapData)) {
            if (building.type !== 'greatbuilding') continue;
            fsp.allGBs.push(building);
        }
        fsp.allGBs.sort((a, b) => {
            const nameA = MainParser.CityEntities[a.cityentity_id].name;
            const nameB = MainParser.CityEntities[b.cityentity_id].name;
            return nameA > nameB ? 1 : nameA < nameB ? -1 : 0;
        });

        HTML.AddCssFile('fsp');

        HTML.Box({
            'id': 'fspMenu',
            'title': 'FSP',
            'auto_close': true,
            'dragdrop': true,
            'minimize': false
        });

        fsp.singleAidKitID = Object.values(MainParser.Inventory).find(x => x.itemAssetName === 'motivate_one').id;
        fsp.finishSpecialID = Object.values(MainParser.Inventory).find(x => x.itemAssetName === 'rush_single_event_building_instant').id;

        fsp.refreshDialog();
    },

    onGBSelect: () => {
        FoEproxy.sendRequest(fsp.reqData.enter(fsp.currGB, fsp.player_id), fsp.refreshDialog);
    },

    targetName: () => {
        if (fsp.target_id == null) return 'none';
        const mapEntry = MainParser.CityMapData[fsp.target_id];
        if (mapEntry == undefined) return 'unknown';
        return MainParser.CityEntities[mapEntry.cityentity_id].name;
    },

    gbName: () => {
        const gb = (fsp.allGBs || []).find(a => a.id === fsp.currGB);
        return gb ? MainParser.CityEntities[gb.cityentity_id].name : null;
    },


    /* ------------------------------------------------------------------ *
     * Runner
     * ------------------------------------------------------------------ */

    // The loop needs both ends wired up: something to harvest, and somewhere to
    // put the forge points it produces.
    canStart: () => fsp.target_id != null && fsp.currGB != null,

    start: () => {
        if (!fsp.canStart()) return;

        fsp.running = true;
        fsp.stop = false;
        fsp.lastError = null;
        fsp.goofy(fsp.aid);
        fsp.refreshDialog();
    },

    requestStop: () => {
        fsp.stop = true;
        fsp.refreshDialog();
    },

    finish: (message) => {
        fsp.running = false;
        fsp.step = null;
        fsp.lastError = message || null;
        fsp.refreshDialog();
    },

    abort: (message) => {
        fsp.finish(message);
    },

    setStep: (step) => {
        fsp.step = step;
        fsp.refreshDialog();
    },

    goofy: (func) => {
        FoEproxy.sendRequest(fsp.reqData.goofy(),
            () => setTimeout(func, 750 + Math.ceil(Math.random() * 250)));
    },

    aid: () => {
        if (fsp.stop) fsp.target_id = null;

        if (fsp.target_id == null) {
            fsp.stop = false;
            fsp.finish('Stopped');
            return;
        }

        if (BlueGalaxy.DoubleCollections === 0 && !fsp.ignoreBG) {
            fsp.abort('No BG charges');
            return;
        }

        if (MainParser.Inventory[fsp.singleAidKitID].inStock < fsp.MIN_ITEMS) {
            fsp.abort('Not enough self-aid kits');
            return;
        }

        fsp.setStep(`Aiding ${fsp.targetName()}`);

        FoEproxy.sendRequest(fsp.reqData.aid(fsp.singleAidKitID, fsp.target_id),
            () => setTimeout(fsp.goofy, 800 + Math.ceil(Math.random() * 300), fsp.finishSpecial));
    },

    finishSpecial: () => {
        if (MainParser.Inventory[fsp.finishSpecialID].inStock < fsp.MIN_ITEMS) {
            fsp.abort('Not enough finish special productions');
            return;
        }

        fsp.setStep(`Finishing ${fsp.targetName()}`);

        FoEproxy.sendRequest(fsp.reqData.finishSpecial(fsp.finishSpecialID, fsp.target_id),
            () => setTimeout(fsp.collect, 800 + Math.ceil(Math.random() * 400)));
    },

    collect: () => {
        fsp.setStep(`Collecting ${fsp.targetName()}`);

        FoEproxy.sendRequest(fsp.reqData.collect(fsp.target_id),
            () => setTimeout(fsp.enter, 600 + Math.ceil(Math.random() * 200)));
    },

    enter: () => {
        fsp.setStep(`Opening ${fsp.gbName() || 'GB'}`);

        FoEproxy.sendRequest(fsp.reqData.enter(fsp.currGB, fsp.player_id),
            () => setTimeout(fsp.contribute, 500 + Math.ceil(Math.random() * 150)));
    },

    contribute: () => {
        // Overfilling a level that can still be levelled would hand the spot away,
        // and a run with nothing left to invest has nowhere to go.
        if (
            (fsp.currLvl < fsp.currMaxLvl && ResourceStock['strategy_points'] > fsp.maxFP - fsp.currFP)
            || ResourceStock['strategy_points'] <= 0
        ) {
            fsp.abort('Too many FP');
            return;
        }

        const amount = ResourceStock['strategy_points'];

        fsp.setStep(`Investing ${amount} FP into ${fsp.gbName() || 'GB'}`);

        FoEproxy.sendRequest(
            fsp.reqData.contribute(fsp.currGB, fsp.player_id, fsp.currLvl, amount),
            () => {
                fsp.collections += 1;
                fsp.fpSpent += amount;
                fsp.currFP += amount;
                setTimeout(fsp.goofy, 500 + Math.ceil(Math.random() * 200), fsp.aid);
            }
        );
    },


    /* ------------------------------------------------------------------ *
     * UI
     * ------------------------------------------------------------------ */

    statusLabel: () => fsp.running ? 'Working' : 'Idle',

    // What the loop would do if it were started right now.
    nextAction: () => {
        if (fsp.target_id == null) return 'Collect a building in the city first';
        if (fsp.currGB == null) return 'Select a GB to dump into';
        return `Harvest ${fsp.targetName()} into ${fsp.gbName()}`;
    },

    refreshDialog: () => {
        if ($('#fspMenu').length === 0) return;

        const gbOptions = (fsp.allGBs || []).map(a =>
            `<option value="${a.id}"${a.id === fsp.currGB ? ' selected' : ''}>${MainParser.CityEntities[a.cityentity_id].name}</option>`
        ).join('');

        let body = [];

        body.push(`<div class="fsp-section dark-bg">
            <label class="fsp-label">Dump FP into</label>
            <select id="fsp_gb_select" class="fsp-select"${fsp.running ? ' disabled' : ''}>
                <option value="" disabled${fsp.currGB == null ? ' selected' : ''}>-- Select a GB --</option>
                ${gbOptions}
            </select>
        </div>`);

        body.push(`<div class="fsp-section dark-bg">
            <label class="fsp-label">Collecting from</label>
            <span id="fsp_target_name" class="fsp-value">${fsp.targetName()}</span>
        </div>`);

        body.push(`<div class="fsp-section fsp-controls">
            <button class="btn-default" onclick="fsp.start();" id="fsp_start"${(fsp.running || !fsp.canStart()) ? ' disabled' : ''}>Start</button>
            <button class="btn-default" onclick="fsp.requestStop();" id="halt"${fsp.running ? '' : ' disabled'}>Stop</button>
        </div>`);

        body.push(`<div class="fsp-section dark-bg fsp-toggle">
            <span class="fsp-label">Status</span>
            <span id="fsp_status" class="fsp-status">${fsp.statusLabel()}</span>
        </div>`);

        body.push(`<div class="fsp-section dark-bg">
            <span class="fsp-label">${fsp.running ? 'Current step' : 'Next action'}</span>
            <span id="fsp_step" class="fsp-value">${fsp.step || fsp.nextAction()}</span>
        </div>`);

        if (fsp.lastError) {
            body.push(`<div class="fsp-section dark-bg">
                <span class="fsp-label">Last message</span>
                <span class="fsp-value fsp-error">${fsp.lastError}</span>
            </div>`);
        }

        body.push(`<div class="fsp-section dark-bg fsp-stats">
            <span>Collections: <strong id="fsp_collections" class="fsp-value">${fsp.collections}</strong></span>
            <span>FP invested: <strong id="fsp_fp" class="fsp-value">${fsp.fpSpent.toLocaleString()}</strong></span>
        </div>`);

        body.push(`<div class="fsp-section fsp-toggle">
            <label class="fsp-label">
                <input type="checkbox" class="game-cursor" id="ignore_bg"${fsp.ignoreBG ? ' checked' : ''}>
                Ignore BG charges
            </label>
            <span id="fsp_ignore_bg_label" class="fsp-status">${fsp.ignoreBG ? 'Active' : 'Off'}</span>
        </div>`);

        $('#fspMenuBody').html(body.join(''));

        document.querySelector('#fsp_gb_select').onchange = function () {
            fsp.currGB = parseInt(this.value, 10);
            fsp.onGBSelect();
        };

        document.querySelector('#ignore_bg').onchange = function () {
            fsp.ignoreBG = this.checked;
            fsp.refreshDialog();
        };
    },

    reqData: {
        goofy: () =>
            `[{"__class__":"ServerRequest","requestData":["item",null],"requestClass":"NoticeIndicatorService","requestMethod":"remove","requestId":67}]`,

        aid: (aidID, targID) =>
            `[{"__class__":"ServerRequest","requestData":[{"__class__":"UseItemOnBuildingPayload","itemId":${aidID},"mapEntityId":${targID},"optionIndex":0}],"requestClass":"InventoryService","requestMethod":"useItem","requestId":67}]`,

        finishSpecial: (fspID, targID) =>
            `[{"__class__":"ServerRequest","requestData":[{"__class__":"UseItemOnBuildingPayload","itemId":${fspID},"mapEntityId":${targID},"optionIndex":0}],"requestClass":"InventoryService","requestMethod":"useItem","requestId":67}]`,

        collect: (targID) =>
            `[{"__class__":"ServerRequest","requestData":[[${targID}]],"requestClass":"CityProductionService","requestMethod":"pickupProduction","requestId":67}]`,

        enter: (bldID, plyrID) =>
            `[{"__class__":"ServerRequest","requestData":[${bldID},${plyrID}],"requestClass":"GreatBuildingsService","requestMethod":"getConstruction","requestId":67}]`,

        contribute: (bldID, plyrID, lvl, amt) =>
            `[{"__class__":"ServerRequest","requestData":[${bldID},${plyrID},${lvl},${amt},false],"requestClass":"GreatBuildingsService","requestMethod":"contributeForgePoints","requestId":67}]`,
    },
};


FoEproxy.addHandler('CityMapService', 'updateEntity', (data, postData) => {
    if (
        data.responseData[0].id == fsp.currGB &&
        data.responseData[0].player_id == fsp.player_id
    ) {
        fsp.currFP = data.responseData[0].state.invested_forge_points ?? 0;
        fsp.maxFP = data.responseData[0].state.forge_points_for_level_up;
        fsp.currLvl = data.responseData[0].level;
        fsp.currMaxLvl = data.responseData[0].max_level;
    }
});

FoEproxy.addHandler('CityProductionService', 'pickupProduction', (data, postData) => {
    fsp.singleAidKitID = Object.values(MainParser.Inventory).find(x => x.itemAssetName === 'motivate_one').id;
    fsp.finishSpecialID = Object.values(MainParser.Inventory).find(x => x.itemAssetName === 'rush_single_event_building_instant').id;

    fsp.player_id = data.responseData.updatedEntities[0].player_id;
    fsp.target_id = postData[0].requestData[0][0];

    fsp.refreshDialog();
});
