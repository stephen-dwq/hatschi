/**
 * GBG Auto helper for FoEProxy
 * Stage 1: Tracks provinces with signal statuses and unlock times
 */

let gbgAuto = {
    // Map of provinceId -> signal status
    // signal can be: "ignore", "focus" or other values
    // if signal is undefined, the province has no active signal
    signals: {},

    // Map of provinceId -> unlock time (unix timestamp in seconds)
    // if lockedUntil is undefined, the province is unlocked
    provinceLocks: {},

    // Map of provinceId -> timeout ID for automatic unlock
    // Used to clear timeouts if lock time is updated before unlock
    unlockTimeouts: {},

    /**
     * Initialize signals and locks from getBattleground response
     * Signals are stored in participants[].signals[]
     * Locks are stored in map.provinces[].lockedUntil
     */
    initializeFromResponse: (responseData) => {
        // Initialize signals from participants
        if (responseData.participants && Array.isArray(responseData.participants)) {
            gbgAuto.initializeSignals(responseData.participants);
        }

        // Initialize province locks from map
        if (responseData.map && responseData.map.provinces && Array.isArray(responseData.map.provinces)) {
            gbgAuto.initializeProvinceLocks(responseData.map.provinces);
        }
    },

    /**
     * Initialize signal tracking from participants array
     * Signals are stored in participants[].signals[]
     */
    initializeSignals: (participants) => {
        gbgAuto.signals = {};
        if (!participants || !Array.isArray(participants)) {
            return;
        }

        for (let participant of participants) {
            if (participant.signals && Array.isArray(participant.signals)) {
                for (let signalData of participant.signals) {
                    gbgAuto.setSignal(signalData.provinceId, signalData.signal);
                }
            }
        }
    },

    /**
     * Initialize province lock times from provinces array
     * lockedUntil is a unix timestamp in seconds, or undefined if unlocked
     * Note: Province with id=0 doesn't have an id field present
     */
    initializeProvinceLocks: (provinces) => {
        gbgAuto.provinceLocks = {};
        if (!provinces || !Array.isArray(provinces)) {
            return;
        }

        for (let i = 0; i < provinces.length; i++) {
            const province = provinces[i];
            // First province (no id field) is id=0, others have explicit id
            const provinceId = province.id !== undefined ? province.id : 0;

            if (province.lockedUntil !== undefined) {
                gbgAuto.setProvinceLock(provinceId, province.lockedUntil);
            } else {
                // Province is unlocked
                gbgAuto.clearProvinceLock(provinceId);
            }
        }
    },

    /**
     * Add or update a signal for a province
     */
    setSignal: (provinceId, signal) => {
        if (signal !== undefined) {
            gbgAuto.signals[provinceId] = signal;
            console.log(`[GBG-Auto] Signal set: Province ${provinceId} -> ${signal}`);
        }
    },

    /**
     * Remove signal from a province
     */
    clearSignal: (provinceId) => {
        if (gbgAuto.signals[provinceId] !== undefined) {
            delete gbgAuto.signals[provinceId];
            console.log(`[GBG-Auto] Signal cleared: Province ${provinceId}`);
        }
    },

    /**
     * Set/update lock time for a province
     * lockedUntil is unix timestamp in seconds
     * Schedules automatic unlock when time expires
     */
    setProvinceLock: (provinceId, lockedUntil) => {
        gbgAuto.provinceLocks[provinceId] = lockedUntil;

        // Clear any existing timeout for this province
        if (gbgAuto.unlockTimeouts[provinceId]) {
            clearTimeout(gbgAuto.unlockTimeouts[provinceId]);
        }

        const now = Math.floor(Date.now() / 1000);
        const timeUntilUnlock = (lockedUntil - now) * 1000; // Convert to milliseconds

        if (timeUntilUnlock > 0) {
            // Schedule automatic unlock at the lock expiration time
            gbgAuto.unlockTimeouts[provinceId] = setTimeout(() => {
                gbgAuto.clearProvinceLock(provinceId);
                console.log(`[GBG-Auto] Province ${provinceId} automatically unlocked (timer expired)`);
            }, timeUntilUnlock);

            console.log(`[GBG-Auto] Province ${provinceId} locked until ${new Date(lockedUntil * 1000).toISOString()} (unlock in ${timeUntilUnlock / 1000}s)`);
        } else {
            // Lock time is in the past, unlock immediately
            gbgAuto.clearProvinceLock(provinceId);
            console.log(`[GBG-Auto] Province ${provinceId} lock time is in the past, unlocking immediately`);
        }
    },

    /**
     * Clear lock from a province (mark as unlocked)
     */
    clearProvinceLock: (provinceId) => {
        if (gbgAuto.provinceLocks[provinceId] !== undefined) {
            delete gbgAuto.provinceLocks[provinceId];

            // Clean up any pending timeout
            if (gbgAuto.unlockTimeouts[provinceId]) {
                clearTimeout(gbgAuto.unlockTimeouts[provinceId]);
                delete gbgAuto.unlockTimeouts[provinceId];
            }

            console.log(`[GBG-Auto] Province ${provinceId} is now unlocked`);
        }
    },

    /**
     * Get unlock time for a province
     * Returns unix timestamp in seconds, or undefined if unlocked
     */
    getProvinceLockTime: (provinceId) => {
        return gbgAuto.provinceLocks[provinceId];
    },

    /**
     * Check if a province is locked
     */
    isProvinceLocked: (provinceId) => {
        const lockTime = gbgAuto.provinceLocks[provinceId];
        if (lockTime === undefined) {
            return false; // Unlocked
        }
        const now = Math.floor(Date.now() / 1000);
        return lockTime > now;
    },

    /**
     * Get remaining lock time in seconds for a province
     * Returns 0 if unlocked or past unlock time
     */
    getProvinceLockTimeRemaining: (provinceId) => {
        const lockTime = gbgAuto.provinceLocks[provinceId];
        if (lockTime === undefined) {
            return 0;
        }
        const now = Math.floor(Date.now() / 1000);
        return Math.max(0, lockTime - now);
    },

    /**
     * Get all provinces with active signals
     */
    getSignaledProvinces: () => {
        return Object.keys(gbgAuto.signals).map(id => ({
            provinceId: parseInt(id),
            signal: gbgAuto.signals[id]
        }));
    },

    /**
     * Get signal status for a specific province
     */
    getSignal: (provinceId) => {
        return gbgAuto.signals[provinceId];
    },

    /**
     * Check if a province has any signal
     */
    hasSignal: (provinceId) => {
        return gbgAuto.signals[provinceId] !== undefined;
    }
};

/**
 * Handler: Initialize signals and locks on GBG load
 */
FoEproxy.addHandler('GuildBattlegroundService', 'getBattleground', (data, postData) => {
    if (data.responseData) {
        gbgAuto.initializeFromResponse(data.responseData);
    }
});

/**
 * Handler: Track signal updates in real-time via websocket
 */
FoEproxy.addWsHandler('GuildBattlegroundSignalsService', 'updateSignal', (data, postData) => {
    if (!data.responseData) {
        return;
    }

    const provinceId = data.responseData.provinceId;
    const signal = data.responseData.signal;

    if (signal !== undefined) {
        // Setting a signal
        gbgAuto.setSignal(provinceId, signal);
    } else {
        // Clearing a signal
        gbgAuto.clearSignal(provinceId);
    }
});

/**
 * Handler: Track province unlock status via getProvinces websocket
 * Server sends getProvinces when conquest state updates on a specific province
 * When a province's lockedUntil time expires, the field is removed
 * Note: Province with id=0 may not have the id field present (id field is undefined)
 */
FoEproxy.addWsHandler('GuildBattlegroundService', 'getProvinces', (data, postData) => {
    if (!data.responseData || !Array.isArray(data.responseData) || data.responseData.length === 0) {
        return;
    }

    // getProvinces typically returns a single province update
    const province = data.responseData[0];

    // Handle province id - id=0 may have undefined id field
    const provinceId = province.id !== undefined ? province.id : 0;

    if (province.lockedUntil !== undefined) {
        // Province is still locked, update the lock time
        gbgAuto.setProvinceLock(provinceId, province.lockedUntil);
    } else {
        // Province has no lockedUntil field, so it's unlocked
        gbgAuto.clearProvinceLock(provinceId);
    }
});

/**
 * Handler: Track province locks when conquered via getAction websocket
 * When a province is conquered, it locks for 4 hours (14400 seconds)
 * Note: Province with id=0 may not have the provinceId field present
 */
FoEproxy.addWsHandler('GuildBattlegroundService', 'getAction', (data, postData) => {
    if (!data.responseData || !Array.isArray(data.responseData) || data.responseData.length === 0) {
        return;
    }

    const action = data.responseData[0];

    // Handle province conquest events
    if (action.action === 'province_conquered') {
        // Handle province id - id=0 may have undefined provinceId field
        const provinceId = action.provinceId !== undefined ? action.provinceId : 0;
        const conquestTime = action.time; // unix timestamp in seconds

        // Province locks for 4 hours after conquest
        const LOCK_DURATION = 4 * 60 * 60; // 4 hours in seconds
        const lockedUntil = conquestTime + LOCK_DURATION;

        gbgAuto.setProvinceLock(provinceId, lockedUntil);
    }
});

