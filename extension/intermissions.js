'use strict';

// Native
const fs = require('fs');
const path = require('path');

// Packages
const clone = require('clone');
const debounce = require('lodash.debounce');
const schemaDefaults = require('json-schema-defaults');

// Ours
const caspar = require('./caspar');
const nodecg = require('./util/nodecg-api-context').get();
const obs = require('./obs');
const TimeUtils = require('./lib/time');

const AD_LOG_PATH = 'logs/ad_log.csv';
const CANT_START_REASONS = {
	ALREADY_STARTED: 'already started',
	ALREADY_COMPLETED: 'already completed',
	RUN_ACTIVE: 'run in progress',
	PRIOR_BREAK_INCOMPLETE: 'a prior ad break is not complete',
	MUST_ADVANCE_SCHEDULE: 'stream tech must go to next run'
};

let currentAdBreak = null;
let currentlyPlayingAd = null;
let nextAd = null;
let cancelledAdBreak = false;
const log = new nodecg.Logger(`${nodecg.bundleName}:intermission`);
const currentIntermission = nodecg.Replicant('currentIntermission');
const canSeekSchedule = nodecg.Replicant('canSeekSchedule');
const currentRun = nodecg.Replicant('currentRun');
const schedule = nodecg.Replicant('schedule');
const stopwatch = nodecg.Replicant('stopwatch');
const schemasPath = path.resolve(__dirname, '../schemas/');
const adBreakSchema = JSON.parse(fs.readFileSync(path.join(schemasPath, 'types/adBreak.json')));
const adSchema = JSON.parse(fs.readFileSync(path.join(schemasPath, 'types/ad.json')));
const debouncedUpdateCurrentIntermissionContent = debounce(_updateCurrentIntermissionContent, 33);
const debouncedUpdateCurrentIntermissionState = debounce(_updateCurrentIntermissionState, 33);
const clearableTimeouts = new Set();
const clearableIntervals = new Set();

currentRun.on('change', (newVal, oldVal) => {
	if (!oldVal || newVal.order !== oldVal.order) {
		debouncedUpdateCurrentIntermissionContent();
	}
});
stopwatch.on('change', (newVal, oldVal) => {
	checkCanSeek();

	if (!oldVal || (hasRunStarted() ? 'post' : 'pre') !== currentIntermission.value.preOrPost) {
		return debouncedUpdateCurrentIntermissionContent();
	}

	if (newVal.state !== oldVal.state) {
		debouncedUpdateCurrentIntermissionState();
	}
});
caspar.replicants.files.on('change', () => {
	debouncedUpdateCurrentIntermissionState();
});

nodecg.listenFor('intermissions:startAdBreak', adBreakId => {
	const adBreak = currentIntermission.value.content.find(item => {
		return item.type === 'adBreak' && item.id === adBreakId;
	});

	if (!adBreak) {
		log.error(`Failed to start ad break: Could not find adBreak ID #${adBreakId} in currentIntermission.`);
		return;
	}

	cancelledAdBreak = false;
	currentAdBreak = adBreak;
	checkCanSeek();

	obs.setCurrentScene('Advertisements').then(() => {
		return playAd(adBreak.ads[0]).then(() => {
			adBreak.state.canStart = false;
			adBreak.state.cantStartReason = CANT_START_REASONS.ALREADY_STARTED;
			adBreak.state.started = true;
		});
	}).catch(e => {
		log.error('Failed to start ad break:', e);
	});
});

nodecg.listenFor('intermissions:cancelAdBreak', adBreakId => {
	const adBreak = currentIntermission.value.content.find(item => {
		return item.type === 'adBreak' && item.id === adBreakId;
	});

	if (!adBreak) {
		log.error(`Failed to cancel ad break: Could not find adBreak ID #${adBreakId} in currentIntermission.`);
		return;
	}

	log.warn(`Cancelling adBreak ID #${adBreakId}!`);
	cancelledAdBreak = true;
	currentAdBreak = null;
	currentlyPlayingAd = null;
	clearableTimeouts.forEach(timeout => clearTimeout(timeout));
	clearableTimeouts.clear();
	clearableIntervals.forEach(interval => clearInterval(interval));
	clearableIntervals.clear();
	caspar.clear().then(() => {
		_updateCurrentIntermissionContent();
	}).catch(err => {
		log.error('Failed to clear Caspar:', err);
	});
	obs.setCurrentScene('Break').catch(e => {
		log.error('Failed to set scene back to "Break" after cancelling ad break:', e);
	});
});

nodecg.listenFor('intermissions:completeAdBreak', adBreakId => {
	const adBreak = currentIntermission.value.content.find(item => {
		return item.type === 'adBreak' && item.id === adBreakId;
	});

	if (!adBreak) {
		log.error(`Failed to complete ad break: Could not find adBreak ID #${adBreakId} in currentIntermission.`);
		return;
	}

	if (adBreak === currentAdBreak) {
		finishCurrentAdBreak();
	} else {
		finishAdBreak(adBreak);
	}
});

nodecg.listenFor('intermissions:completeImageAd', adId => {
	if (!currentlyPlayingAd) {
		log.error(`Tried to mark image ad ID #${adId} as complete, but no ad is currently playing.`);
		return;
	}

	if (adId !== currentlyPlayingAd.id) {
		log.error(`Tried to mark image ad ID #${adId} as complete, but it wasn't the currentlyPlayingAd.`);
		return;
	}

	finishAd(currentlyPlayingAd);

	if (nextAd) {
		playAd(nextAd).catch(e => {
			log.error('Failed to play ad:', e);
		});
	} else {
		log.error(`Marked image ad ID #${adId} as complete, but there was no nextAd!`);
	}
});

caspar.osc.on('foregroundChanged', filename => {
	if (cancelledAdBreak) {
		return;
	}

	if (!currentAdBreak) {
		// There will be some cases where this is *not* an error, such as
		// if we play another outro video like the one Bestban made for AGDQ2017.
		// However, this is rare enough that I'm comfortable leaving this as an error log,
		// which will ping me in Slack. - Lange 2017/06/20
		log.error(
			`"${filename}" started playing in CasparCG, but no adBreak is active.`,
			'Letting it play, no action will be taken.'
		);
		return;
	}

	// Images include the media folder name in the path, but videos don't... dumb.
	if (filename.startsWith('media/')) {
		filename = filename.replace('media/', '');
	}

	let indexOfAdThatJustStarted = -1;
	const adThatJustStarted = currentAdBreak.ads.find((ad, index) => {
		if (ad.filename.toLowerCase() === filename.toLowerCase() && ad.state.completed === false) {
			indexOfAdThatJustStarted = index;
			return true;
		}
		return false;
	});
	if (!adThatJustStarted) {
		currentlyPlayingAd = null;
		currentAdBreak = null;
		log.error(
			`"${filename}" started playing in CasparCG, but it did not correspond to any ad in the current adBreak.`,
			'Caspar will now be cleared to get us back into a predictable state.',
		);
		caspar.clear().then(() => {
			checkCanSeek();
		}).catch(err => {
			log.error('Failed to clear Caspar:', err);
		});
		return;
	}

	if (adThatJustStarted.state.started) {
		return;
	}

	currentlyPlayingAd = adThatJustStarted;
	adThatJustStarted.state.started = true;
	adThatJustStarted.state.canStart = false;

	const adThatJustCompleted = indexOfAdThatJustStarted > 0 ?
		currentAdBreak.ads[indexOfAdThatJustStarted - 1] :
		null;
	if (adThatJustCompleted && !adThatJustCompleted.state.completed) {
		finishAd(adThatJustCompleted);
	}

	nextAd = currentAdBreak.ads[indexOfAdThatJustStarted + 1];
	let nextAdFilenameNoExt;
	if (nextAd) {
		nextAdFilenameNoExt = path.parse(nextAd.filename).name;
		caspar.loadbgAuto(nextAdFilenameNoExt).catch(e => {
			log.error('Failed to play ad:', e);
		});
	} else if (currentlyPlayingAd.adType.toLowerCase() === 'video') {
		const frameTime = 1000 / adThatJustStarted.state.fps;
		const timeout = setTimeout(() => {
			if (!currentlyPlayingAd) {
				log.warn('Had no currentlyPlayingAd after the timeout, that\'s weird.');
				caspar.clear().catch(err => {
					log.error('Failed to clear Caspar:', err);
				});
				return;
			}

			if (currentlyPlayingAd.adType.toLowerCase() === 'video') {
				finishCurrentAdBreak();
			}
		}, frameTime * adThatJustStarted.state.durationFrames);
		clearableTimeouts.add(timeout);
	}

	if (adThatJustStarted.adType.toLowerCase() === 'image') {
		const MS_PER_FRAME = 1000 / 60;
		const startTime = Date.now();
		const interval = setInterval(() => {
			adThatJustStarted.state.frameNumber = Math.min(
				(Date.now() - startTime) / MS_PER_FRAME,
				adThatJustStarted.state.durationFrames
			);

			adThatJustStarted.state.framesLeft =
				adThatJustStarted.state.durationFrames - adThatJustStarted.state.frameNumber;

			if (adThatJustStarted.state.framesLeft <= 0) {
				clearInterval(interval);
				adThatJustStarted.state.canComplete = true;
				if (!nextAd) {
					currentAdBreak.state.canComplete = true;
				}
			}
		}, MS_PER_FRAME);
		clearableIntervals.add(interval);
	}
});

function finishAd(ad) {
	try {
		writeAdToLog(ad);
	} catch (error) {
		nodecg.log.error('writeAdToLog failed:', error);
	}

	ad.state.started = true;
	ad.state.canStart = false;
	ad.state.completed = true;
	ad.state.canComplete = false;
	ad.state.framesLeft = 0;
	ad.state.frameNumber = ad.state.durationFrames;
}

function finishAdBreak(adBreak) {
	adBreak.state.started = true;
	adBreak.state.canStart = false;
	adBreak.state.cantStartReason = CANT_START_REASONS.ALREADY_COMPLETED;
	adBreak.state.completed = true;
	adBreak.state.canComplete = false;
}

function finishCurrentAdBreak() {
	caspar.clear().catch(err => {
		log.error('Failed to clear Caspar:', err);
	});
	finishAd(currentlyPlayingAd);
	finishAdBreak(currentAdBreak);
	currentAdBreak = null;
	currentlyPlayingAd = null;
	obs.setCurrentScene('Break').catch(e => {
		log.error('Failed to set scene back to "Break" after completing ad break:', e);
	});
	checkCanSeek();
}

caspar.osc.on('frameChanged', (currentFrame, durationFrames) => {
	if (currentlyPlayingAd && currentlyPlayingAd.adType.toLowerCase() === 'video') {
		currentlyPlayingAd.state.frameNumber = currentFrame;
		currentlyPlayingAd.state.framesLeft = durationFrames - currentFrame;
	}
});

function playAd(ad) {
	const adFilenameNoExt = path.parse(ad.filename).name;
	caspar.resetState();
	return caspar.play(adFilenameNoExt);
}

/**
 * Sets the `preOrPost` and `content` properties of the currentIntermission replicant.
 * @returns {undefined}
 * @private
 */
function _updateCurrentIntermissionContent() {
	if (!currentRun.value || !stopwatch.value || !schedule.value) {
		return;
	}

	// If the timer hasn't started yet, use the intermission between the previous run and currentRun.
	// Else, use the intermission between currentRun and nextRun.
	currentIntermission.value = {
		preOrPost: hasRunStarted() ? 'post' : 'pre',
		content: calcIntermissionContent()
	};

	_updateCurrentIntermissionState();
	checkCanSeek();
}

/**
 * Updates the `state` property of individual content items within the currentIntermission replicant.
 * @returns {undefined}
 * @private
 */
function _updateCurrentIntermissionState() {
	if (!currentIntermission.value || !caspar.replicants.files.value) {
		return;
	}

	let allPriorAdBreaksAreComplete = true;
	currentIntermission.value.content.forEach(item => {
		if (item.type !== 'adBreak') {
			return;
		}

		item.state.canStart = true;
		item.state.cantStartReason = '';

		if (item.state.started) {
			item.state.canStart = false;
			item.state.cantStartReason = CANT_START_REASONS.ALREADY_STARTED;
		}

		if (item.state.completed) {
			item.state.canStart = false;
			item.state.cantStartReason = CANT_START_REASONS.ALREADY_COMPLETED;
		}

		if (!allPriorAdBreaksAreComplete) {
			item.state.canStart = false;
			item.state.cantStartReason = CANT_START_REASONS.PRIOR_BREAK_INCOMPLETE;
		}

		if (hasRunFinished()) {
			item.state.canStart = false;
			item.state.cantStartReason = CANT_START_REASONS.MUST_ADVANCE_SCHEDULE;
		} else if (hasRunStarted()) {
			item.state.canStart = false;
			item.state.cantStartReason = CANT_START_REASONS.RUN_ACTIVE;
		}

		if (!item.state.completed) {
			allPriorAdBreaksAreComplete = false;
		}

		item.ads.forEach(ad => {
			const casparFile = caspar.replicants.files.value.find(file => {
				return file.nameWithExt.toLowerCase() === ad.filename.toLowerCase();
			});

			if (!casparFile) {
				log.error(`Ad points to file that does not exist in CasparCG: ${ad.filename}`);
				return;
			}

			if (casparFile.type.toLowerCase() === 'video') {
				ad.state.durationFrames = casparFile.frames;
				ad.state.fps = casparFile.frameRate;
			} else if (casparFile.type.toLowerCase() === 'image') {
				ad.state.durationFrames = (TimeUtils.parseTimeString(ad.duration) / 1000) * 60;
				ad.state.fps = 60;
			} else {
				log.error('Unexpected file type from CasparCG:', casparFile);
			}
		});
	});
}

/**
 * Calculates what the contents of `currentIntermission` should be based on the values of
 * `currentRun`, `schedule`, and whether the currentRun has started or not.
 * @returns {Array<Object>} - The intermission content.
 */
function calcIntermissionContent() {
	const preOrPost = hasRunStarted() ? 'post' : 'pre';
	const intermissionContent = [];
	const scheduleContent = preOrPost === 'pre' ?
		schedule.value.slice(0).reverse() :
		schedule.value;

	let foundCurrentRun = false;
	scheduleContent.some(item => {
		if (item.id === currentRun.value.id) {
			foundCurrentRun = true;
			return false;
		}

		if (foundCurrentRun) {
			if (item.type === 'run') {
				return true;
			}

			const clonedItem = clone(item);
			if (item.type === 'adBreak') {
				clonedItem.state = schemaDefaults(adBreakSchema.properties.state);
				clonedItem.ads.forEach(ad => {
					ad.state = schemaDefaults(adSchema.properties.state);
				});
			}
			intermissionContent.push(clonedItem);
		}

		return false;
	});

	return preOrPost === 'pre' ? intermissionContent.reverse() : intermissionContent;
}

/**
 * Returns true if the current run has begun, false otherwise.
 * @returns {boolean} - Whether or not the current run has started.
 */
function hasRunStarted() {
	return stopwatch.value.state !== 'not_started';
}

/**
 * Returns true if the current run has completed, false otherwise.
 * @returns {boolean} - Whether or not the current run has finished.
 */
function hasRunFinished() {
	return stopwatch.value.state === 'finished';
}

function checkCanSeek() {
	// If the timer is running, disallow seeking.
	if (stopwatch.value.state === 'running') {
		canSeekSchedule.value = false;
		return;
	}

	// If an ad break is in progress, disallow seeking.
	if (currentAdBreak) {
		canSeekSchedule.value = false;
		return;
	}

	// Else, allow seeking.
	canSeekSchedule.value = true;
}

/**
 * Writes detailed information about an ad to the ad log.
 * @param {Object} ad - The ad to log.
 * @returns {undefined}
 */
function writeAdToLog(ad) {
	const data = [
		ad.id,
		new Date().toISOString(),
		ad.adType,
		ad.sponsorName,
		ad.name,
		ad.filename,
		currentRun.value.name
	];

	const logStr = data.join(', ');
	log.info('Ad successfully completed:', logStr);

	// If the ad log does not exist yet, create it and add the header row.
	if (!fs.existsSync(AD_LOG_PATH)) {
		const headerRow = 'id, timestamp, type, sponsor_name, ad_name, file_name, current_run\n';
		fs.writeFileSync(AD_LOG_PATH, headerRow);
	}

	// Append this ad play to the ad log.
	fs.appendFile(AD_LOG_PATH, logStr + '\n', err => {
		if (err) {
			log.error('Error appending to log:', err.stack);
		}
	});
}
