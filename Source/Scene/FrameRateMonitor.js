/*global define*/
define([
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/Event',
        '../Core/getTimestamp'
    ], function(
        defaultValue,
        defined,
        defineProperties,
        destroyObject,
        DeveloperError,
        Event,
        getTimestamp) {
    "use strict";

    /**
     * Monitors the frame rate (frames per second) in a {@link Scene} and raises an event if the frame rate is
     * lower than a threshold.  Later, if the frame rate returns to the required level, a separate event is raised.
     * To avoid creating multiple FrameRateMonitors for a single {@link Scene}, use {@link FrameRateMonitor.fromScene}
     * instead of constructing an instance explicitly.
     *
     * @alias FrameRateMonitor
     * @constructor
     *
     * @param {Scene} scene The Scene instance for which to monitor performance.
     * @param {Number} [samplingWindow=5000] The length of the sliding window over which to compute the average frame rate, in milliseconds.
     * @param {Number} [quietPeriod=2000] The length of time to wait at startup and each time the page becomes visible (i.e. when the user
     *        switches back to the tab) before starting to measure performance, in milliseconds.
     * @param {Number} [warmupPeriod=5000] The length of the warmup period, in milliseconds.  During the warmup period, a separate
     *        (usually lower) frame rate is required.
     * @param {Number} [minimumFrameRateDuringWarmup=4] The minimum frames-per-second that are required for acceptable performance during
     *        the warmup period.  If the frame rate averages less than this during any samplingWindow during the warmupPeriod, the
     *        lowFrameRate event will be raised and the page will redirect to the redirectOnLowFrameRateUrl, if any.
     * @param {Number} [minimumFrameRateAfterWarmup=8] The minimum frames-per-second that are required for acceptable performance after
     *        the end of the warmup period.  If the frame rate averages less than this during any samplingWindow after the warmupPeriod, the
     *        lowFrameRate event will be raised and the page will redirect to the redirectOnLowFrameRateUrl, if any.
     */
    var FrameRateMonitor = function(description) {
        //>>includeStart('debug', pragmas.debug);
        if (!defined(description) || !defined(description.scene)) {
            throw new DeveloperError('description.scene is required.');
        }
        //>>includeEnd('debug');

        this._scene = description.scene;

        /**
         * Gets or sets the length of the sliding window over which to compute the average frame rate, in milliseconds.
         * @type {Number}
         */
        this.samplingWindow = defaultValue(description.samplingWindow, FrameRateMonitor.defaultSettings.samplingWindow);

        /**
         * Gets or sets the length of time to wait at startup and each time the page becomes visible (i.e. when the user
         * switches back to the tab) before starting to measure performance, in milliseconds.
         * @type {Number}
         */
        this.quietPeriod = defaultValue(description.quietPeriod, FrameRateMonitor.defaultSettings.quietPeriod);

        /**
         * Gets or sets the length of the warmup period, in milliseconds.  During the warmup period, a separate
         * (usually lower) frame rate is required.
         * @type {Number}
         */
        this.warmupPeriod = defaultValue(description.warmupPeriod, FrameRateMonitor.defaultSettings.warmupPeriod);

        /**
         * Gets or sets the minimum frames-per-second that are required for acceptable performance during
         * the warmup period.  If the frame rate averages less than this during any <code>samplingWindow</code> during the <code>warmupPeriod</code>, the
         * <code>lowFrameRate</code> event will be raised and the page will redirect to the <code>redirectOnLowFrameRateUrl</code>, if any.
         * @type {Number}
         */
        this.minimumFrameRateDuringWarmup = defaultValue(description.minimumFrameRateDuringWarmup, FrameRateMonitor.defaultSettings.minimumFrameRateDuringWarmup);

        /**
         * Gets or sets the minimum frames-per-second that are required for acceptable performance after
         * the end of the warmup period.  If the frame rate averages less than this during any <code>samplingWindow</code> after the <code>warmupPeriod</code>, the
         * <code>lowFrameRate</code> event will be raised and the page will redirect to the <code>redirectOnLowFrameRateUrl</code>, if any.
         * @type {Number}
         */
        this.minimumFrameRateAfterWarmup = defaultValue(description.minimumFrameRateAfterWarmup, FrameRateMonitor.defaultSettings.minimumFrameRateAfterWarmup);

        this._lowFrameRate = new Event();
        this._nominalFrameRate = new Event();

        this._frameTimes = [];
        this._needsQuietPeriod = true;
        this._quietPeriodEndTime = 0.0;
        this._warmupPeriodEndTime = 0.0;
        this._frameRateIsLow = false;
        this._lastFramesPerSecond = undefined;

        var that = this;
        this._preRenderRemoveListener = this._scene.preRender.addEventListener(function(scene, time) {
            update(that, time);
        });

        this._hiddenPropertyName = defined(document.hidden) ? 'hidden' :
                                   defined(document.mozHidden) ? 'mozHidden' :
                                   defined(document.msHidden) ? 'msHidden' :
                                   defined(document.webkitHidden) ? 'webkitHidden' : undefined;

        var visibilityChangeEventName = defined(document.hidden) ? 'visibilitychange' :
            defined(document.mozHidden) ? 'mozvisibilitychange' :
            defined(document.msHidden) ? 'msvisibilitychange' :
            defined(document.webkitHidden) ? 'webkitvisibilitychange' : undefined;

        function visibilityChangeListener() {
            visibilityChanged(that);
        }

        this._visibilityChangeRemoveListener = undefined;
        if (defined(visibilityChangeEventName)) {
            document.addEventListener(visibilityChangeEventName, visibilityChangeListener, false);

            this._visibilityChangeRemoveListener = function() {
                document.removeEventListener(visibilityChangeEventName, visibilityChangeListener, false);
            };
        }
    };

    /**
     * The default frame rate monitoring settings.  These settings are used when {@link FrameRateMonitor.fromScene}
     * needs to create a new frame rate monitor, and for any settings that are not passed to the
     * {@link FrameRateMonitor} constructor.
     *
     * @memberof FrameRateMonitor
     */
    FrameRateMonitor.defaultSettings = {
        samplingWindow : 5000,
        quietPeriod : 2000,
        warmupPeriod : 5000,
        minimumFrameRateDuringWarmup : 4,
        minimumFrameRateAfterWarmup : 8
    };

    /**
     * Gets the {@link FrameRateMonitor} for a given scene.  If the scene does not yet have
     * a {@link FrameRateMonitor}, one is created with the {@link FrameRateMonitor.defaultSettings}.
     *
     * @param {Scene} scene The scene for which to get the {@link FrameRateMonitor}.
     * @returns {FrameRateMonitor} The scene's {@link FrameRateMonitor}.
     */
    FrameRateMonitor.fromScene = function(scene) {
        //>>includeStart('debug', pragmas.debug);
        if (!defined(scene)) {
            throw new DeveloperError('scene is required.');
        }
        //>>includeEnd('debug');

        if (!defined(scene._frameRateMonitor) || scene._frameRateMonitor.isDestroyed()) {
            scene._frameRateMonitor = new FrameRateMonitor({
                scene : scene
            });
        }

        return scene._frameRateMonitor;
    };

    defineProperties(FrameRateMonitor.prototype, {
        /**
         * Gets the {@link Scene} instance for which to monitor performance.
         * @memberof FrameRateMonitor.prototype
         * @type {Scene}
         */
        scene : {
            get : function() {
                return this._scene;
            }
        },

        /**
         * Gets the event that is raised when a low frame rate is detected.  The function will be passed
         * the {@link Scene} instance as its first parameter and the average number of frames per second
         * over the sampling window as its second parameter.
         * @memberof FrameRateMonitor.prototype
         * @type {Event}
         */
        lowFrameRate : {
            get : function() {
                return this._lowFrameRate;
            }
        },

        /**
         * Gets the event that is raised when the frame rate returns to a normal level after having been low.
         * The function will be passed the {@link Scene} instance as its first parameter and the average
         * number of frames per second over the sampling window as its second parameter.
         * @memberof FrameRateMonitor.prototype
         * @type {Event}
         */
        nominalFrameRate : {
            get : function() {
                return this._nominalFrameRate;
            }
        },

        /**
         * Gets the most recently computed average frames-per-second over the last <code>samplingWindow</code>.
         * This property may be undefined if the frame rate has not been computed.
         * @memberof FrameRateMonitor.prototype
         * @type {Number}
         */
        lastFramesPerSecond : {
            get : function() {
                return this._lastFramesPerSecond;
            }
        }
    });

    FrameRateMonitor.prototype.isDestroyed = function() {
        return false;
    };

    FrameRateMonitor.prototype.destroy = function() {
        this._preRenderRemoveListener();

        if (defined(this._visibilityChangeRemoveListener)) {
            this._visibilityChangeRemoveListener();
        }

        return destroyObject(this);
    };

    function update(monitor, time) {
        if (defined(monitor._hiddenPropertyName) && document[monitor._hiddenPropertyName]) {
            return;
        }

        var timeStamp = getTimestamp();

        if (monitor._needsQuietPeriod) {
            monitor._needsQuietPeriod = false;
            monitor._frameTimes.length = 0;
            monitor._quietPeriodEndTime = timeStamp + monitor.quietPeriod;
            monitor._warmupPeriodEndTime = monitor._quietPeriodEndTime + monitor.warmupPeriod + monitor.samplingWindow;
        } else if (timeStamp >= monitor._quietPeriodEndTime) {
            monitor._frameTimes.push(timeStamp);

            var beginningOfWindow = timeStamp - monitor.samplingWindow;

            if (monitor._frameTimes.length >= 2 && monitor._frameTimes[0] <= beginningOfWindow) {
                while (monitor._frameTimes.length >= 2 && monitor._frameTimes[1] < beginningOfWindow) {
                    monitor._frameTimes.shift();
                }

                var averageTimeBetweenFrames = (timeStamp - monitor._frameTimes[0]) / (monitor._frameTimes.length - 1);

                monitor._lastFramesPerSecond = 1000.0 / averageTimeBetweenFrames;

                var maximumFrameTime = 1000.0 / (timeStamp > monitor._warmupPeriodEndTime ? monitor.minimumFrameRateAfterWarmup : monitor.minimumFrameRateDuringWarmup);
                if (averageTimeBetweenFrames > maximumFrameTime) {
                    if (!monitor._frameRateIsLow) {
                        monitor._frameRateIsLow = true;
                        monitor._needsQuietPeriod = true;
                        monitor.lowFrameRate.raiseEvent(monitor.scene, monitor._lastFramesPerSecond);
                    }
                } else if (monitor._frameRateIsLow) {
                    monitor._frameRateIsLow = false;
                    monitor._needsQuietPeriod = true;
                    monitor.nominalFrameRate.raiseEvent(monitor.scene, monitor._lastFramesPerSecond);
                }
            }
        }
    }

    function visibilityChanged(monitor) {
        if (document[monitor._hiddenPropertyName]) {
            monitor._frameTimes.length = 0;
            monitor._lastFramesPerSecond = undefined;
        } else {
            monitor._needsQuietPeriod = true;
        }
    }

    return FrameRateMonitor;
});