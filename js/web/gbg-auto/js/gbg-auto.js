/**
 * GBG Auto helper for FoEProxy
 * Fire-control, targeting, and automated attack queue for GBG.
 */

FoEproxy.addHandler('AnnouncementsService', 'fetchAllAnnouncements', () => {
    gbgAuto.abort();
    HTML.CloseOpenBox('gbgAutoMenu');
});

FoEproxy.addHandler('GuildBattlegroundService', 'getBattleground', () => {
    if ($('#gbgAutoMenu').length > 0) return;
    gbgAuto.ShowDialog();
});

FoEproxy.addWsHandler('GuildBattlegroundSignalsService', 'updateSignal', () => {
    gbgAuto.onMapUpdate();
});

FoEproxy.addWsHandler('GuildBattlegroundService', 'getProvinces', () => {
    gbgAuto.onMapUpdate();
});

let gbgAuto = {
    active: false,
    attacking: false,
    strictFireControl: true,
    lastError: null,
    ATTRITION_CHANCE: 20,
    ATTRITION_PROGRESS_CAP: 90,

    getPlayerGuildId: () => GuildFights.MapData?.currentParticipantId,

    compactProvinceName: (name) => {
        if (!name) return null;
        const match = name.match(/^([^:]+):\s*(\S+)/);
        return match ? `${match[1]}:${match[2]}` : name;
    },

    getProvinceLabel: (province) => {
        if (province?.short) return province.short;

        const meta = ProvinceMap?.ProvinceData?.().find(e => e.id === province.id);
        if (meta?.short) return meta.short;

        const compact = gbgAuto.compactProvinceName(province?.name || meta?.name);
        if (compact) return compact;

        return `${province.id}`;
    },

    getProvinceLabelById: (id) => {
        const province = ProvinceMap?.Provinces?.find(p => p.id === id);
        if (province) return gbgAuto.getProvinceLabel(province);

        const meta = ProvinceMap?.ProvinceData?.().find(e => e.id === id);
        if (meta?.short) return meta.short;

        const compact = gbgAuto.compactProvinceName(meta?.name);
        if (compact) return compact;

        return `${id}`;
    },

    getPlayerProgress: (province) => {
        const playerGuildId = gbgAuto.getPlayerGuildId();
        if (!playerGuildId) return 0;

        const entry = (province.conquestProgress || []).find(p => p.participantId === playerGuildId);
        return entry?.progress ?? 0;
    },

    isOwnedByPlayer: (province) => province.owner.id === gbgAuto.getPlayerGuildId(),

    isIgnored: (province) => province.signal === 'ignore',

    getAttackableProvinces: () => {
        if (!ProvinceMap?.getAttackableProvinces) return [];
        return ProvinceMap.getAttackableProvinces();
    },

    isFocusAttackTarget: (province) => {
        if (gbgAuto.isIgnored(province)) return false;
        if (gbgAuto.isOwnedByPlayer(province)) return false;
        return province.signal === 'focus';
    },

    isFocusWithAttrition20: (province) => {
        return gbgAuto.isFocusAttackTarget(province)
            && province.gainAttritionChance === gbgAuto.ATTRITION_CHANCE;
    },

    isFocusWithAttritionAbove20: (province) => {
        return gbgAuto.isFocusAttackTarget(province)
            && province.gainAttritionChance > gbgAuto.ATTRITION_CHANCE;
    },

    isFocusTier2: (province) => {
        return gbgAuto.isFocusAttackTarget(province)
            && !gbgAuto.isFocusWithAttrition20(province);
    },

    isAttritionFallbackTarget: (province) => {
        if (gbgAuto.isIgnored(province)) return false;
        if (gbgAuto.isOwnedByPlayer(province)) return false;
        if (province.gainAttritionChance !== gbgAuto.ATTRITION_CHANCE) return false;
        return gbgAuto.getPlayerProgress(province) < gbgAuto.ATTRITION_PROGRESS_CAP;
    },

    getTargetProvinces: () => {
        const attackable = gbgAuto.getAttackableProvinces();

        if (gbgAuto.strictFireControl) {
            return attackable.filter(gbgAuto.isFocusAttackTarget);
        }

        const tier1 = attackable.filter(gbgAuto.isFocusWithAttrition20);
        const tier1Ids = new Set(tier1.map(p => p.id));

        const tier2 = attackable.filter(p => gbgAuto.isFocusTier2(p) && !tier1Ids.has(p.id));
        const focusIds = new Set([...tier1, ...tier2].map(p => p.id));

        const tier3 = attackable.filter(p => !focusIds.has(p.id) && gbgAuto.isAttritionFallbackTarget(p));

        return tier1.concat(tier2, tier3);
    },

    selectTarget: () => {
        const targets = gbgAuto.getTargetProvinces();
        return targets.length > 0 ? targets[0] : null;
    },

    getTargetTier: (province) => {
        if (!gbgAuto.getAttackableProvinces().some(p => p.id === province.id)) return null;

        if (gbgAuto.strictFireControl) {
            return gbgAuto.isFocusAttackTarget(province) ? 'focus' : null;
        }

        if (gbgAuto.isFocusWithAttrition20(province)) return 'focus-20';
        if (gbgAuto.isFocusTier2(province)) {
            return gbgAuto.isFocusWithAttritionAbove20(province) ? 'focus-high' : 'focus';
        }
        if (gbgAuto.isAttritionFallbackTarget(province)) return 'attrition';
        return null;
    },

    onMapUpdate: () => {
        if ($('#gbgAutoMenu').length > 0) gbgAuto.refreshDialog();
        if (gbgAuto.active && !gbgAuto.attacking) {
            gbgAuto.tryAdvanceQueue();
        }
    },

    setActive: (active) => {
        if (!active) {
            gbgAuto.abort();
        }

        gbgAuto.active = active;
        gbgAuto.lastError = null;

        if (active) {
            gbgAuto.tryAdvanceQueue();
        }

        gbgAuto.refreshDialog();
    },

    abort: () => {
        gbg.stop = true;
        gbg.currentTarget = null;
        gbgAuto.attacking = false;
    },

    tryAdvanceQueue: () => {
        if (!gbgAuto.active || gbgAuto.attacking) return;

        const target = gbgAuto.selectTarget();
        if (!target) return;

        gbgAuto.startAttackOnTarget(target);
    },

    startAttackOnTarget: (province) => {
        gbgAuto.attacking = true;
        gbgAuto.lastError = null;
        gbg.currentTarget = province.id;
        gbg.stop = false;
        gbg.doEncounter(-1);
        gbgAuto.refreshDialog();
    },

    onJobFinished: () => {
        gbgAuto.attacking = false;
        gbg.currentTarget = null;
        gbgAuto.refreshDialog();

        if (gbgAuto.active) {
            gbgAuto.tryAdvanceQueue();
        }
    },

    onAttackAborted: (message) => {
        gbgAuto.attacking = false;
        gbg.currentTarget = null;

        if (!gbgAuto.active) {
            gbgAuto.lastError = null;
            gbgAuto.refreshDialog();
            return;
        }

        gbgAuto.lastError = message;
        gbgAuto.refreshDialog();

        const fatal = ['NO TEMPLATE', 'NO UNITS', 'LOW UNITS', 'WAVECOUNT NULL', 'BATTLESWON NULL', 'ERA NULL'];
        if (fatal.includes(message)) {
            gbgAuto.active = false;
            return;
        }

        gbgAuto.tryAdvanceQueue();
    },

    getStatusLabel: () => {
        if (gbgAuto.attacking) return 'Attacking';
        if (gbgAuto.active) return 'Active';
        return 'Inactive';
    },

    getDisplayTarget: () => {
        if (gbg.currentTarget != null) {
            return gbgAuto.getProvinceLabelById(gbg.currentTarget);
        }

        const next = gbgAuto.selectTarget();
        return next ? gbgAuto.getProvinceLabel(next) : 'None';
    },

    ShowDialog: () => {
        HTML.AddCssFile('gbg-auto');

        HTML.Box({
            id: 'gbgAutoMenu',
            title: 'GBG Auto',
            auto_close: true,
            dragdrop: true,
            minimize: false
        });

        gbgAuto.refreshDialog();
    },

    refreshDialog: () => {
        if ($('#gbgAutoMenu').length === 0) return;

        const targets = gbgAuto.getTargetProvinces();
        const modeLabel = gbgAuto.strictFireControl ? 'Strict' : 'Nonstrict';
        const statusLabel = gbgAuto.getStatusLabel();
        const targetLabel = gbgAuto.attacking
            ? `Attacking ${gbgAuto.getDisplayTarget()}`
            : gbgAuto.getDisplayTarget();

        let body = [];
        body.push(`<div class="gbg-auto-section dark-bg gbg-auto-toggle">
            <label class="gbg-auto-label">
                <input type="checkbox" class="game-cursor" id="gbgAutoActive"${gbgAuto.active ? ' checked' : ''}>
                Bot active
            </label>
            <span id="gbgAutoStatus" class="gbg-auto-status">${statusLabel}</span>
        </div>`);
        body.push(`<div class="gbg-auto-section dark-bg gbg-auto-toggle">
            <label class="gbg-auto-label">
                <input type="checkbox" class="game-cursor" id="gbgAutoStrict"${gbgAuto.strictFireControl ? ' checked' : ''}>
                Strict fire-control
            </label>
            <span id="gbgAutoMode" class="gbg-auto-status">${modeLabel}</span>
        </div>`);
        body.push(`<div class="gbg-auto-section dark-bg">
            <span class="gbg-auto-label">${gbgAuto.attacking ? 'Current target' : 'Next target'}</span>
            <span id="gbgAutoSelected" class="gbg-auto-value">${targetLabel}</span>
        </div>`);

        if (gbgAuto.lastError) {
            body.push(`<div class="gbg-auto-section dark-bg">
                <span class="gbg-auto-label">Last error</span>
                <span class="gbg-auto-value gbg-auto-error">${gbgAuto.lastError}</span>
            </div>`);
        }

        body.push(`<div class="gbg-auto-section dark-bg">
            <span class="gbg-auto-label">Queue (${targets.length})</span>
            <div id="gbgAutoTargetList" class="gbg-auto-province-list">${gbgAuto.renderTargetList()}</div>
        </div>`);

        $('#gbgAutoMenuBody').html(body.join(''));

        document.querySelector('#gbgAutoActive').oninput = function () {
            gbgAuto.setActive(this.checked);
        };
        document.querySelector('#gbgAutoStrict').oninput = function () {
            gbgAuto.strictFireControl = this.checked;
            gbgAuto.refreshDialog();
            if (gbgAuto.active && !gbgAuto.attacking) {
                gbgAuto.tryAdvanceQueue();
            }
        };
    },

    renderTargetList: () => {
        const targets = gbgAuto.getTargetProvinces();
        if (targets.length === 0) {
            return '<div class="gbg-auto-empty">No targets in queue</div>';
        }

        return targets.map((province) => {
            const tier = gbgAuto.getTargetTier(province);
            const tierLabel = {
                'focus-20': 'focus+20%',
                'focus-high': 'focus>20%',
                'focus': 'focus',
                'attrition': '20%'
            }[tier] || tier;
            const signal = province.signal || 'none';
            const attrition = province.gainAttritionChance ?? '—';
            const progress = gbgAuto.getPlayerProgress(province);
            const current = gbg.currentTarget === province.id ? ' gbg-auto-province-current' : '';
            return `<div class="gbg-auto-province-item${current}">
                <span class="gbg-auto-province-id">${gbgAuto.getProvinceLabel(province)}</span>
                <span class="gbg-auto-tier gbg-auto-tier-${tier}">${tierLabel}</span>
                <span class="gbg-auto-signal">${signal} · ${attrition}% · ${progress}</span>
            </div>`;
        }).join('');
    }
};
