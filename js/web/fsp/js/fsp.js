let fsp = {

    collections: 0,         // num collections made this session
    stop: false,            // stop flag for automation loop
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

        const gbOptions = fsp.allGBs.map(a =>
            `<option value="${a.id}">${MainParser.CityEntities[a.cityentity_id].name}</option>`
        ).join('');

        const body = `
            <div class="fsp-section dark-bg">
                <label class="fsp-label">Dump FP into</label>
                <select id="fsp_gb_select" class="fsp-select">
                    <option value="" disabled selected>-- Select a GB --</option>
                    ${gbOptions}
                </select>
            </div>
            <div class="fsp-section dark-bg">
                <label class="fsp-label">Collecting from</label>
                <span id="fsp_target_name" class="fsp-value">${fsp._targetName()}</span>
            </div>
            <div class="fsp-section fsp-controls">
                <button class="btn-default" onclick="fsp.stop = false; fsp.lockDialog(); fsp.goofy(fsp.aid);" id="fsp_start" disabled>Start</button>
                <button class="btn-default" onclick="fsp.stop = true;" id="halt" disabled>Stop</button>
            </div>
            <div class="fsp-section dark-bg fsp-stats">
                <span>Collections: <strong id="fsp_collections" class="fsp-value">${fsp.collections}</strong></span>
            </div>
            <div class="fsp-section fsp-toggle">
                <label class="fsp-label">
                    <input type="checkbox" class="game-cursor" id="ignore_bg">
                    Ignore BG charges
                </label>
                <span id="fsp_ignore_bg_label" class="fsp-status">${fsp.ignoreBG ? 'Active' : 'Off'}</span>
            </div>
        `;

        $('#fspMenuBody').html(body);

        document.getElementById('fsp_gb_select').onchange = function () {
            fsp.currGB = parseInt(this.value, 10);
            fsp.onGBSelect();
        };

        document.getElementById('ignore_bg').onchange = function () {
            fsp.ignoreBG = this.checked;
            fsp.refreshDialog();
        };

        fsp.singleAidKitID = Object.values(MainParser.Inventory).find(x => x.itemAssetName === 'motivate_one').id;
        fsp.finishSpecialID = Object.values(MainParser.Inventory).find(x => x.itemAssetName === 'rush_single_event_building_instant').id;

        fsp.refreshDialog();
    },

    onGBSelect: () => {
        FoEproxy.sendRequest(fsp.reqData.enter(fsp.currGB, fsp.player_id),
            () => { document.getElementById('fsp_start').disabled = (fsp.target_id == null); });
    },

    _targetName: () => {
        if (fsp.target_id == null) return 'none';
        const mapEntry = MainParser.CityMapData[fsp.target_id];
        if (mapEntry == undefined) return 'unknown';
        return MainParser.CityEntities[mapEntry.cityentity_id].name;
    },

    refreshDialog: () => {
        const el_bg = document.getElementById('fsp_ignore_bg_label');
        const el_target = document.getElementById('fsp_target_name');
        const el_collections = document.getElementById('fsp_collections');
        if (el_bg) el_bg.innerHTML = fsp.ignoreBG ? 'Active' : 'Off';
        if (el_target) el_target.innerHTML = fsp._targetName();
        if (el_collections) el_collections.innerHTML = fsp.collections;
    },

    lockDialog: () => {
        document.getElementById('halt').disabled = false;
        document.getElementById('fsp_start').disabled = true;
        fsp.refreshDialog();
    },

    unlockDialog: () => {
        document.getElementById('halt').disabled = true;
        document.getElementById('fsp_start').disabled = false;
        fsp.refreshDialog();
    },

    goofy: (func) => {
        FoEproxy.sendRequest(fsp.reqData.goofy(),
            () => setTimeout(func, 750 + Math.ceil(Math.random() * 250)));
    },

    aid: () => {
        fsp.refreshDialog();

        if (fsp.stop) fsp.target_id = null;

        if (fsp.target_id == null) {
            fsp.stop = false;
            fsp.unlockDialog();
            alert('Stopped');
            return;
        }

        if (BlueGalaxy.DoubleCollections === 0 && !fsp.ignoreBG) {
            fsp.unlockDialog();
            alert('No BG Charges');
            return;
        }

        if (MainParser.Inventory[fsp.singleAidKitID].inStock < 25) {
            fsp.unlockDialog();
            alert('Not enough self-aid kits');
            return;
        }

        FoEproxy.sendRequest(fsp.reqData.aid(fsp.singleAidKitID, fsp.target_id),
            () => setTimeout(fsp.goofy, 800 + Math.ceil(Math.random() * 300), fsp.finishSpecial));
    },

    finishSpecial: () => {
        if (MainParser.Inventory[fsp.finishSpecialID].inStock < 25) {
            alert('Not enough finish special productions');
            return;
        }

        FoEproxy.sendRequest(fsp.reqData.finishSpecial(fsp.finishSpecialID, fsp.target_id),
            () => setTimeout(fsp.collect, 800 + Math.ceil(Math.random() * 400)));
    },

    collect: () => {
        FoEproxy.sendRequest(fsp.reqData.collect(fsp.target_id),
            () => setTimeout(fsp.enter, 600 + Math.ceil(Math.random() * 200)));
    },

    enter: () => {
        FoEproxy.sendRequest(fsp.reqData.enter(fsp.currGB, fsp.player_id),
            () => setTimeout(fsp.contribute, 500 + Math.ceil(Math.random() * 150)));
    },

    contribute: () => {
        if (
            (fsp.currLvl < fsp.currMaxLvl && ResourceStock['strategy_points'] > fsp.maxFP - fsp.currFP)
            || ResourceStock['strategy_points'] <= 0
        ) {
            fsp.unlockDialog();
            alert('Too many FP');
            return;
        }

        FoEproxy.sendRequest(
            fsp.reqData.contribute(fsp.currGB, fsp.player_id, fsp.currLvl, ResourceStock['strategy_points']),
            () => {
                fsp.collections += 1;
                fsp.currFP += ResourceStock['strategy_points'];
                setTimeout(fsp.goofy, 500 + Math.ceil(Math.random() * 200), fsp.aid);
            }
        );
    },

    reqData: {
        goofy: () =>
            `[{"__class__":"ServerRequest","requestData":["item",null],"requestClass":"NoticeIndicatorService","requestMethod":"remove","requestId":7}]`,

        aid: (aidID, targID) =>
            `[{"__class__":"ServerRequest","requestData":[{"__class__":"UseItemOnBuildingPayload","itemId":${aidID},"mapEntityId":${targID},"optionIndex":0}],"requestClass":"InventoryService","requestMethod":"useItem","requestId":7}]`,

        finishSpecial: (fspID, targID) =>
            `[{"__class__":"ServerRequest","requestData":[{"__class__":"UseItemOnBuildingPayload","itemId":${fspID},"mapEntityId":${targID},"optionIndex":0}],"requestClass":"InventoryService","requestMethod":"useItem","requestId":7}]`,

        collect: (targID) =>
            `[{"__class__":"ServerRequest","requestData":[[${targID}]],"requestClass":"CityProductionService","requestMethod":"pickupProduction","requestId":7}]`,

        enter: (bldID, plyrID) =>
            `[{"__class__":"ServerRequest","requestData":[${bldID},${plyrID}],"requestClass":"GreatBuildingsService","requestMethod":"getConstruction","requestId":7}]`,

        contribute: (bldID, plyrID, lvl, amt) =>
            `[{"__class__":"ServerRequest","requestData":[${bldID},${plyrID},${lvl},${amt},false],"requestClass":"GreatBuildingsService","requestMethod":"contributeForgePoints","requestId":7}]`,
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