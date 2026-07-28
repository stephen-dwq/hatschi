/**
 * Collect All helper for FoEProxy
 * Walks every collectable building in the city one at a time and dumps the
 * harvested forge points into a designated great building.
 */

let CollectAll = {

    running: false,         // a run is in progress
    stop: false,            // stop flag for the collection loop

    queue: [],              // map entity ids still waiting to be collected
    queueSize: 0,           // size of the queue when the run started
    collected: 0,           // buildings collected this run
    skipped: 0,             // buildings that were no longer collectable
    deposited: 0,           // FP contributed this run
    pending: 0,             // FP known to be in the bar, still to be swept into the GB
    status: 'Idle',         // how the last run ended, shown in the dialog
    statusIsError: false,   // whether that status was a failure

    allGBs: [],             // array of all player GBs, built in Show()
    currGB: null,           // map entity id of the target GB


    /**
     * Every building in the city that currently has a finished production.
     */
    getCollectables: () => {
        return Object.values(MainParser.CityMapData)
            .filter(building => building?.state?.__class__ === 'ProductionFinishedState')
            .map(building => building.id)
            .sort((a, b) => a - b);
    },

    /**
     * The whole forge point bar. pickupProduction answers with updated
     * resources, so this is current by the time a deposit is sent.
     */
    availableFP: () => ResourceStock['strategy_points'] | 0,


    Show: () => {
        CollectAll.allGBs = [];
        for (let building of Object.values(MainParser.CityMapData)) {
            if (building.type !== 'greatbuilding') continue;
            CollectAll.allGBs.push(building);
        }
        CollectAll.allGBs.sort((a, b) => {
            const nameA = MainParser.CityEntities[a.cityentity_id].name;
            const nameB = MainParser.CityEntities[b.cityentity_id].name;
            return nameA > nameB ? 1 : nameA < nameB ? -1 : 0;
        });

        HTML.AddCssFile('collect-all');

        HTML.Box({
            'id': 'collectAllMenu',
            'title': 'Collect All',
            'auto_close': true,
            'dragdrop': true,
            'minimize': false
        });

        const gbOptions = CollectAll.allGBs.map(a =>
            `<option value="${a.id}"${a.id === CollectAll.currGB ? ' selected' : ''}>${MainParser.CityEntities[a.cityentity_id].name}</option>`
        ).join('');

        const body = `
            <div class="collect-all-section dark-bg">
                <label class="collect-all-label">Dump FP into</label>
                <select id="collect_all_gb_select" class="collect-all-select">
                    <option value="" disabled${CollectAll.currGB == null ? ' selected' : ''}>-- Select a GB --</option>
                    ${gbOptions}
                </select>
            </div>
            <div class="collect-all-section dark-bg collect-all-row">
                <span class="collect-all-label">Ready to collect</span>
                <span id="collect_all_available" class="collect-all-value">0</span>
            </div>
            <div class="collect-all-section collect-all-controls">
                <button class="btn-default" onclick="CollectAll.start();" id="collect_all_start" disabled>Collect All</button>
                <button class="btn-default" onclick="CollectAll.stop = true;" id="collect_all_halt" disabled>Stop</button>
            </div>
            <div class="collect-all-section dark-bg">
                <div class="collect-all-row">
                    <span class="collect-all-label">Progress</span>
                    <span id="collect_all_progress" class="collect-all-value">-</span>
                </div>
                <div class="collect-all-bar">
                    <div id="collect_all_bar_fill" class="collect-all-bar-fill"></div>
                </div>
            </div>
            <div class="collect-all-section dark-bg collect-all-row">
                <span class="collect-all-label">FP deposited</span>
                <span id="collect_all_deposited" class="collect-all-value">0</span>
            </div>
            <div class="collect-all-section dark-bg collect-all-row">
                <span class="collect-all-label">Status</span>
                <span id="collect_all_status" class="collect-all-value">Idle</span>
            </div>
        `;

        $('#collectAllMenuBody').html(body);

        document.getElementById('collect_all_gb_select').onchange = function () {
            CollectAll.currGB = parseInt(this.value, 10);
            CollectAll.refreshDialog();
        };

        if (CollectAll.running) {
            CollectAll.lockDialog();
        } else {
            CollectAll.refreshDialog();
        }
    },

    refreshDialog: () => {
        if ($('#collectAllMenu').length === 0) return;

        const available = CollectAll.running ? CollectAll.queue.length : CollectAll.getCollectables().length;

        const el_available = document.getElementById('collect_all_available');
        const el_progress = document.getElementById('collect_all_progress');
        const el_deposited = document.getElementById('collect_all_deposited');
        const el_status = document.getElementById('collect_all_status');
        const el_start = document.getElementById('collect_all_start');
        const el_bar = document.getElementById('collect_all_bar_fill');

        if (el_available) el_available.innerHTML = available;

        // buildings dealt with, whether they were collected or already gone
        const handled = CollectAll.collected + CollectAll.skipped;
        const percent = CollectAll.queueSize === 0 ? 0 : Math.round((handled / CollectAll.queueSize) * 100);

        if (el_progress) {
            el_progress.innerHTML = CollectAll.queueSize === 0
                ? '-'
                : `${handled} / ${CollectAll.queueSize} (${percent}%)${CollectAll.skipped > 0 ? ` &middot; ${CollectAll.skipped} skipped` : ''}`;
        }

        if (el_bar) el_bar.style.width = percent + '%';

        if (el_deposited) {
            el_deposited.innerHTML = `${CollectAll.deposited} (${CollectAll.availableFP()} in bar)`;
        }

        if (el_status) {
            el_status.innerHTML = CollectAll.running ? 'Collecting' : CollectAll.status;
            el_status.classList.toggle('collect-all-error', !CollectAll.running && CollectAll.statusIsError);
        }

        if (el_start && !CollectAll.running) {
            el_start.disabled = (CollectAll.currGB == null || available === 0);
        }
    },

    lockDialog: () => {
        const el_halt = document.getElementById('collect_all_halt');
        const el_start = document.getElementById('collect_all_start');
        if (el_halt) el_halt.disabled = false;
        if (el_start) el_start.disabled = true;
        CollectAll.refreshDialog();
    },

    unlockDialog: () => {
        const el_halt = document.getElementById('collect_all_halt');
        if (el_halt) el_halt.disabled = true;
        CollectAll.refreshDialog();
    },


    start: () => {
        if (CollectAll.running) return;

        if (CollectAll.currGB == null) {
            CollectAll.finish('No GB selected');
            return;
        }

        if (ActiveMap !== 'main') {
            CollectAll.finish('Not on the city map');
            return;
        }

        CollectAll.queue = CollectAll.getCollectables();
        CollectAll.queueSize = CollectAll.queue.length;

        if (CollectAll.queueSize === 0) {
            CollectAll.finish('Nothing to collect');
            return;
        }

        CollectAll.running = true;
        CollectAll.stop = false;
        CollectAll.collected = 0;
        CollectAll.skipped = 0;
        CollectAll.deposited = 0;
        CollectAll.pending = 0;
        CollectAll.status = 'Collecting';
        CollectAll.statusIsError = false;

        CollectAll.lockDialog();
        CollectAll.next();
    },

    /**
     * Takes the next building off the queue and collects it. Buildings that
     * were collected elsewhere in the meantime are skipped.
     */
    next: () => {
        CollectAll.refreshDialog();

        if (CollectAll.stop) {
            CollectAll.finish('Stopped', false);
            return;
        }

        if (CollectAll.queue.length === 0) {
            CollectAll.finish('Done', false);
            return;
        }

        const id = CollectAll.queue.shift();

        if (MainParser.CityMapData[id]?.state?.__class__ !== 'ProductionFinishedState') {
            CollectAll.skipped += 1;
            CollectAll.next();
            return;
        }

        CollectAll.collect(id);
    },

    collect: (id) => {
        FoEproxy.sendRequest(CollectAll.reqData.collect(id), () => {
            CollectAll.collected += 1;
            setTimeout(() => {
                CollectAll.pending = CollectAll.availableFP();
                CollectAll.deposit();
            }, 600 + Math.ceil(Math.random() * 300));
        });
    },

    deposit: () => {
        if (CollectAll.stop) {
            CollectAll.finish('Stopped', false);
            return;
        }

        // most buildings pay out something other than FP - nothing to deposit
        if (CollectAll.pending === 0) {
            CollectAll.next();
            return;
        }

        FoEproxy.sendRequest(CollectAll.reqData.enter(CollectAll.currGB, ExtPlayerID),
            () => setTimeout(CollectAll.contribute, 500 + Math.ceil(Math.random() * 150)));
    },

    /**
     * Sweeps the forge point bar into the target GB. A sweep that would
     * overshoot the current level is trimmed to exactly what the level still
     * needs; the GB then auto-levels and the rest goes into the next level.
     */
    contribute: () => {
        const gb = MainParser.CityMapData[CollectAll.currGB];

        if (gb === undefined) {
            CollectAll.abort('Target GB not found');
            return;
        }

        // max_level is only a cap when it is actually set
        if (gb.max_level && gb.level >= gb.max_level) {
            CollectAll.abort('Target GB is at max level, no levels left to unlock');
            return;
        }

        const room = (gb.state.forge_points_for_level_up | 0) - (gb.state.invested_forge_points | 0);

        // already filled and waiting to be levelled - nothing can be deposited
        if (room <= 0) {
            CollectAll.abort('Target GB is full, level it up before collecting again');
            return;
        }

        const amount = Math.min(CollectAll.pending, room);

        FoEproxy.sendRequest(
            CollectAll.reqData.contribute(CollectAll.currGB, ExtPlayerID, gb.level, amount),
            () => {
                CollectAll.deposited += amount;
                CollectAll.pending -= amount;

                // anything left over goes into the level the GB just unlocked
                setTimeout(
                    CollectAll.pending > 0 ? CollectAll.deposit : CollectAll.next,
                    500 + Math.ceil(Math.random() * 200)
                );
            }
        );
    },

    finish: (message, isError = true) => {
        CollectAll.running = false;
        CollectAll.stop = false;
        CollectAll.status = message;
        CollectAll.statusIsError = isError;
        CollectAll.unlockDialog();
    },

    abort: (message) => {
        CollectAll.finish(message);
        alert('Collect All: ' + message);
    },


    reqData: {
        collect: (targID) =>
            `[{"__class__":"ServerRequest","requestData":[[${targID}]],"requestClass":"CityProductionService","requestMethod":"pickupProduction","requestId":67}]`,

        enter: (bldID, plyrID) =>
            `[{"__class__":"ServerRequest","requestData":[${bldID},${plyrID}],"requestClass":"GreatBuildingsService","requestMethod":"getConstruction","requestId":67}]`,

        contribute: (bldID, plyrID, lvl, amt) =>
            `[{"__class__":"ServerRequest","requestData":[${bldID},${plyrID},${lvl},${amt},false],"requestClass":"GreatBuildingsService","requestMethod":"contributeForgePoints","requestId":67}]`,
    },
};


FoEproxy.addFoeHelperHandler('CityMapUpdated', () => {
    if (!CollectAll.running) CollectAll.refreshDialog();
});
