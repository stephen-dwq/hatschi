let fsp = {
    collections: null, // num collections

    allGBs: null, // constructed as allGBs in profile.js

    // metadata of current fp dump
    currGB: null,
    currFP: null,
    maxFP: null,
    currLvl: null,
    currMaxLvl: null,

    singleAidKitID: null, // constructed as inventoryList in profile.js
    finishSpecialID: null,

    player_id: null, // obtained by 'CityProductionService', 'pickupProduction', data.responseData.updatedEntities[0].player_id
    target_id: null, // obtained by 'CityProductionService', 'pickupProduction', postData[0].requestData[0][0]

    Show: () => {
        console.log("fsp.Show()");
    }
};

FoEproxy.addHandler('CityMapService', 'updateEntity', (data, postData) => {
    if (data.responseData[0].id == fsp.currGB && data.responseData[0].player_id == fsp.player_id) {
        fsp.currFP = (data.responseData[0].state.invested_forge_points !== undefined ? data.responseData[0].state.invested_forge_points : 0);
        fsp.maxFP = data.responseData[0].state.forge_points_for_level_up;
        fsp.currLvl = data.responseData[0].level;
        fsp.currMaxLvl = data.responseData[0].max_level;
    }
});

FoEproxy.addHandler('CityProductionService', 'pickupProduction', (data, postData) => {
    fsp.player_id = data.responseData.updatedEntities[0].player_id; // playerid
    fsp.target_id = postData[0].requestData[0][0]; // buildingid
    /*
    console.log(MainParser.CityMapData[postData[0].requestData[0][0]].cityentity_id); // cityentity_id
    console.log(MainParser.CityEntities[MainParser.CityMapData[postData[0].requestData[0][0]].cityentity_id].name); // human-legible name
    */
});