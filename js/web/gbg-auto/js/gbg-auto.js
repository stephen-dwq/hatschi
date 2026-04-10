/**
 * GBG Auto helper for FoEProxy
 * Bot layer that orchestrates GBG automation using map state from guildfights.js/ProvinceMap
 *
 * All map state (provinces, signals, attrition) is now centralized in guildfights.js:
 * - Province.gainAttritionChance is updated via RefreshSector
 * - Province.signal is updated via GuildBattlegroundSignalsService/updateSignal handler
 * - ProvinceMap.getAttackableProvinces() returns provinces that can be attacked
 * - ProvinceMap.getTargetProvinces() returns provinces that should be targeted
 */

let gbgAuto = {
    /**
     * Get all provinces that can currently be attacked
     * Delegates to ProvinceMap for actual query
     * @returns {Array} Array of Province objects that can be attacked
     */
    getAttackableProvinces: () => {
        if (!ProvinceMap || !ProvinceMap.getAttackableProvinces) {
            return [];
        }
        return ProvinceMap.getAttackableProvinces();
    },

    /**
     * Get all provinces that should be attacked
     * Delegates to ProvinceMap for actual query
     * @returns {Array} Array of Province objects that should be targeted
     */
    getTargetProvinces: () => {
        if (!ProvinceMap || !ProvinceMap.getTargetProvinces) {
            return [];
        }
        return ProvinceMap.getTargetProvinces();
    }
};

