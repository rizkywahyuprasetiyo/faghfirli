const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Lang = imports.lang;
const Soup = imports.gi.Soup;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;
const Settings = imports.ui.settings;

function MyApplet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

MyApplet.prototype = {
    __proto__: Applet.TextApplet.prototype,

    _init: function(metadata, orientation, panel_height, instance_id) {
        Applet.TextApplet.prototype._init.call(this, orientation, panel_height, instance_id);
        
        this._metadata = metadata;
        this._httpSession = new Soup.Session();
        this._prayerSchedule = null;
        this._nextPrayerIndex = 0;
        this._countdownTimer = null;
        this._fetchTimer = null;
        this._blinkTimer = null;
        this._blinkStartTime = null;
        this._currentPrayerName = "";
        this._isBlinking = false;
        
        // Initialize settings
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        
        // Bind settings
        this.settings.bind("city-name", "_cityName", this._onSettingsChanged.bind(this));
        this.settings.bind("coordinates", "_coordinates", this._onSettingsChanged.bind(this));
        this.settings.bind("show-imsak", "_showImsak", this._onSettingsChanged.bind(this));
        
        this.settings.bind("adjust-subuh", "_adjustSubuh", this._onSettingsChanged.bind(this));
        this.settings.bind("adjust-dzuhur", "_adjustDzuhur", this._onSettingsChanged.bind(this));
        this.settings.bind("adjust-ashar", "_adjustAshar", this._onSettingsChanged.bind(this));
        this.settings.bind("adjust-maghrib", "_adjustMaghrib", this._onSettingsChanged.bind(this));
        this.settings.bind("adjust-isya", "_adjustIsya", this._onSettingsChanged.bind(this));
        
        // Parse coordinates
        this._parseCoordinates();
        
        // Use settings with fallback
        this._locationName = this._cityName || "KOTA PONTIANAK";
        
        this.set_applet_tooltip("Klik untuk lihat jadwal sholat lengkap");
        
        // Setup menu popup
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        
        // Styling
        this.actor.add_style_class_name('faghfirli-applet');
        
        // Initial fetch
        this._fetchPrayerSchedule();
        
        // Schedule next day fetch at midnight
        this._scheduleNextFetch();
    },

    _parseCoordinates: function() {
        // Parse coordinates from string format "latitude, longitude"
        let coords = this._coordinates || "-0.087466, 109.347654";
        let parts = coords.split(',').map(s => s.trim());
        
        if (parts.length >= 2) {
            this._latitude = parseFloat(parts[0]) || -0.087466;
            this._longitude = parseFloat(parts[1]) || 109.347654;
        } else {
            // Default to Pontianak coordinates
            this._latitude = -0.087466;
            this._longitude = 109.347654;
        }
    },

    _fetchPrayerSchedule: function() {
        global.log("Faghfirli: Starting fetch with coords " + this._latitude + ", " + this._longitude);
        
        let now = new Date();
        let timestamp = Math.floor(now.getTime() / 1000);
        
        // AlAdhan API with coordinates - method 20 (Kemenag/Indonesia)
        let url = `https://api.aladhan.com/v1/timings/${timestamp}?latitude=${this._latitude}&longitude=${this._longitude}&method=20`;
        
        global.log("Faghfirli: API URL: " + url);
        
        let message = Soup.Message.new('GET', url);
        
        if (!message) {
            global.log("Faghfirli: Failed to create HTTP message");
            this.set_applet_label("Error: HTTP");
            return;
        }
        
        this._httpSession.send_and_read_async(message, 0, null, Lang.bind(this, function(session, result) {
            global.log("Faghfirli: Async callback triggered");
            try {
                let bytes = session.send_and_read_finish(result);
                global.log("Faghfirli: HTTP status: " + message.status_code);
                
                if (bytes && message.status_code === 200) {
                    let data = bytes.get_data();
                    let responseStr = "";
                    for (let i = 0; i < data.length; i++) {
                        responseStr += String.fromCharCode(data[i]);
                    }
                    global.log("Faghfirli: Response length: " + responseStr.length);
                    
                    let response = JSON.parse(responseStr);
                    if (response.code === 200 && response.data && response.data.timings) {
                        let timings = response.data.timings;
                        global.log("Faghfirli: Received timings - Imsak:" + timings.Imsak + 
                                   " Fajr:" + timings.Fajr + " Dhuhr:" + timings.Dhuhr + 
                                   " Asr:" + timings.Asr + " Maghrib:" + timings.Maghrib + 
                                   " Isha:" + timings.Isha);
                        
                        // Validate all required timings exist
                        if (!timings.Fajr || !timings.Dhuhr || !timings.Asr || !timings.Maghrib || !timings.Isha) {
                            global.log("Faghfirli: Missing required prayer timings in API response");
                            this.set_applet_label("Error: Data incomplete");
                            return;
                        }
                        
                        // Map AlAdhan response to our format
                        this._prayerSchedule = {
                            imsak: timings.Imsak,
                            subuh: timings.Fajr,
                            dzuhur: timings.Dhuhr,
                            ashar: timings.Asr,
                            maghrib: timings.Maghrib,
                            isya: timings.Isha
                        };
                        
                        global.log("Faghfirli: Calling _parsePrayerTimes");
                        this._parsePrayerTimes();
                        global.log("Faghfirli: PrayerTimes count: " + (this._prayerTimes ? this._prayerTimes.length : 0));
                        
                        // Check if parsing resulted in any prayer times
                        if (!this._prayerTimes || this._prayerTimes.length === 0) {
                            global.log("Faghfirli: No prayer times after parsing");
                            this.set_applet_label("Error: Parse failed");
                            return;
                        }
                        
                        global.log("Faghfirli: Calling _calculateNextPrayer");
                        this._calculateNextPrayer();
                        this._createMenu();
                        this._updateCountdown();
                        this._startCountdownTimer();
                        global.log("Faghfirli: Fetch complete, label: " + this._applet_label);
                    } else {
                        global.log("Faghfirli: Failed to fetch prayer schedule from AlAdhan API. Response code: " + response.code);
                        this.set_applet_label("Error: API " + (response.code || "unknown"));
                    }
                } else {
                    global.log("Faghfirli: HTTP error - status code: " + message.status_code);
                    this.set_applet_label("Error: HTTP " + message.status_code);
                }
            } catch (e) {
                global.log("Faghfirli: Error in fetch callback: " + e + " - Stack: " + (e.stack || "no stack"));
                this.set_applet_label("Error");
            }
        }));
    },

    _parsePrayerTimes: function() {
        let now = new Date();
        this._prayerTimes = [];
        
        // Validate prayer schedule data
        if (!this._prayerSchedule) {
            global.log("Faghfirli: Prayer schedule is null");
            return;
        }
        
        let prayers = [
            { name: "Imsak", time: this._prayerSchedule.imsak, optional: true, adjust: 0 },
            { name: "Subuh", time: this._prayerSchedule.subuh, adjust: this._adjustSubuh || 0 },
            { name: "Dzuhur", time: this._prayerSchedule.dzuhur, adjust: this._adjustDzuhur || 0 },
            { name: "Ashar", time: this._prayerSchedule.ashar, adjust: this._adjustAshar || 0 },
            { name: "Maghrib", time: this._prayerSchedule.maghrib, adjust: this._adjustMaghrib || 0 },
            { name: "Isya", time: this._prayerSchedule.isya, adjust: this._adjustIsya || 0 }
        ];
        
        for (let i = 0; i < prayers.length; i++) {
            if (prayers[i].optional && !this._showImsak) {
                continue;
            }
            
            // Validate time string
            if (!prayers[i].time || typeof prayers[i].time !== 'string') {
                global.log("Faghfirli: Invalid time for " + prayers[i].name + ": " + prayers[i].time);
                continue;
            }
            
            let timeParts = prayers[i].time.split(':');
            if (timeParts.length < 2) {
                global.log("Faghfirli: Invalid time format for " + prayers[i].name + ": " + prayers[i].time);
                continue;
            }
            
            let hours = parseInt(timeParts[0], 10);
            let minutes = parseInt(timeParts[1], 10);
            
            if (isNaN(hours) || isNaN(minutes)) {
                global.log("Faghfirli: NaN values for " + prayers[i].name + " - hours:" + hours + " minutes:" + minutes);
                continue;
            }
            
            // Convert everything to total minutes from midnight for easier calculation
            let totalMinutes = hours * 60 + minutes + prayers[i].adjust;
            
            // Calculate new hours and minutes
            let adjustedHours = Math.floor(totalMinutes / 60);
            let adjustedMinutes = totalMinutes % 60;
            
            // Handle negative minutes
            if (adjustedMinutes < 0) {
                adjustedMinutes += 60;
                adjustedHours -= 1;
            }
            
            // Handle hour wrap (0-23) - but track day offset separately
            let dayOffset = 0;
            while (adjustedHours >= 24) {
                adjustedHours -= 24;
                dayOffset += 1;
            }
            while (adjustedHours < 0) {
                adjustedHours += 24;
                dayOffset -= 1;
            }
            
            // Create the adjusted date
            let adjustedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, adjustedHours, adjustedMinutes, 0);
            
            let adjustedTimeStr = `${String(adjustedHours).padStart(2, '0')}:${String(adjustedMinutes).padStart(2, '0')}`;
            
            global.log("Faghfirli: Parsed " + prayers[i].name + " - Original: " + prayers[i].time + 
                       " Adjust: " + prayers[i].adjust + " dayOffset: " + dayOffset +
                       " Result: " + adjustedTimeStr);
            
            this._prayerTimes.push({
                name: prayers[i].name,
                time: adjustedDate,
                timeStr: adjustedTimeStr,
                originalTime: prayers[i].time,
                adjustment: prayers[i].adjust
            });
        }
    },

    _calculateNextPrayer: function() {
        let now = new Date();
        
        if (!this._prayerTimes || this._prayerTimes.length === 0) {
            this._nextPrayerIndex = -1;
            this._currentPrayerName = "No data";
            return;
        }
        
        for (let i = 0; i < this._prayerTimes.length; i++) {
            if (this._prayerTimes[i].time > now) {
                this._nextPrayerIndex = i;
                this._currentPrayerName = this._prayerTimes[i].name;
                return;
            }
        }
        
        // All prayers passed for today - find Subuh for tomorrow
        // Subuh is always the second prayer in the list (index 1, or index 0 if Imsak is hidden)
        let subuhIndex = -1;
        for (let i = 0; i < this._prayerTimes.length; i++) {
            if (this._prayerTimes[i].name === "Subuh") {
                subuhIndex = i;
                break;
            }
        }
        
        if (subuhIndex !== -1) {
            // Create tomorrow's Subuh time
            let tomorrowSubuh = new Date(this._prayerTimes[subuhIndex].time);
            tomorrowSubuh.setDate(tomorrowSubuh.getDate() + 1);
            
            // Add it to the array as a new entry
            this._prayerTimes.push({
                name: "Subuh",
                time: tomorrowSubuh,
                timeStr: this._prayerTimes[subuhIndex].timeStr,
                originalTime: this._prayerTimes[subuhIndex].originalTime,
                adjustment: this._prayerTimes[subuhIndex].adjustment,
                isTomorrow: true
            });
            
            this._nextPrayerIndex = this._prayerTimes.length - 1;
            this._currentPrayerName = "Subuh";
            global.log("Faghfirli: All prayers passed today, next prayer is tomorrow's Subuh at " + tomorrowSubuh);
        } else {
            this._nextPrayerIndex = -1;
            this._currentPrayerName = "Selesai";
        }
    },

    _updateCountdown: function() {
        if (this._nextPrayerIndex === -1) {
            this.set_applet_label("Selesai");
            return;
        }
        
        if (!this._prayerTimes || this._nextPrayerIndex >= this._prayerTimes.length) {
            this.set_applet_label("Loading...");
            return;
        }
        
        let now = new Date();
        let nextPrayer = this._prayerTimes[this._nextPrayerIndex];
        let diff = nextPrayer.time - now;
        
        if (diff <= 0) {
            // Prayer time has arrived
            if (!this._isBlinking) {
                this._startBlinking();
            }
            return;
        }
        
        // Calculate hours and minutes
        let hours = Math.floor(diff / (1000 * 60 * 60));
        let minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        
        // Format: HH:MM
        let timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        this.set_applet_label(`${nextPrayer.name} -${timeStr}`);
    },

    _startCountdownTimer: function() {
        // Update every minute (60000 ms)
        if (this._countdownTimer) {
            Mainloop.source_remove(this._countdownTimer);
        }
        
        this._countdownTimer = Mainloop.timeout_add(60000, Lang.bind(this, function() {
            this._updateCountdown();
            return true; // Continue timer
        }));
    },

    _startBlinking: function() {
        this._isBlinking = true;
        this._blinkStartTime = new Date();
        
        // Show notification
        this._showNotification(this._currentPrayerName);
        
        // Start blinking
        let blinkState = false;
        this._blinkTimer = Mainloop.timeout_add(500, Lang.bind(this, function() {
            // Check if 5 minutes have passed
            let now = new Date();
            let diff = now - this._blinkStartTime;
            
            if (diff >= 5 * 60 * 1000) { // 5 minutes
                this._stopBlinking();
                this._moveToNextPrayer();
                return false;
            }
            
            // Toggle blink
            blinkState = !blinkState;
            if (blinkState) {
                this.set_applet_label(` ${this._currentPrayerName} `);
                this.actor.add_style_class_name('faghfirli-blink');
            } else {
                this.set_applet_label(this._currentPrayerName);
                this.actor.remove_style_class_name('faghfirli-blink');
            }
            
            return true;
        }));
    },

    _stopBlinking: function() {
        this._isBlinking = false;
        if (this._blinkTimer) {
            Mainloop.source_remove(this._blinkTimer);
            this._blinkTimer = null;
        }
        this.actor.remove_style_class_name('faghfirli-blink');
    },

    _moveToNextPrayer: function() {
        this._nextPrayerIndex++;
        if (this._nextPrayerIndex < this._prayerTimes.length) {
            this._currentPrayerName = this._prayerTimes[this._nextPrayerIndex].name;
            this._updateCountdown();
        } else {
            // All prayers for today are done - trigger a refresh to get tomorrow's schedule
            global.log("Faghfirli: Last prayer finished, fetching tomorrow's schedule...");
            this._fetchPrayerSchedule();
        }
    },

    _showNotification: function(prayerName) {
        try {
            let source = new imports.ui.messageTray.Source("Faghfirli", "appointment-soon");
            imports.ui.main.messageTray.add(source);
            
            let notification = new imports.ui.messageTray.Notification(
                source,
                `Waktunya Sholat ${prayerName}`,
                `Sekarang pukul ${this._prayerTimes[this._nextPrayerIndex].timeStr} - ${this._cityName}`
            );
            notification.setTransient(false);
            source.notify(notification);
        } catch (e) {
            global.log("Faghfirli: Error showing notification: " + e);
        }
    },

    _scheduleNextFetch: function() {
        // Calculate time until next midnight
        let now = new Date();
        let tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0);
        let diff = tomorrow - now;
        
        if (this._fetchTimer) {
            Mainloop.source_remove(this._fetchTimer);
        }
        
        this._fetchTimer = Mainloop.timeout_add(diff, Lang.bind(this, function() {
            this._fetchPrayerSchedule();
            this._scheduleNextFetch();
            return false;
        }));
    },

    _onSettingsChanged: function() {
        global.log("Faghfirli: Settings changed - refreshing...");
        
        // Log adjustment values for debugging
        global.log("Faghfirli: Adjustments - Subuh:" + this._adjustSubuh + 
                   " Dzuhur:" + this._adjustDzuhur + " Ashar:" + this._adjustAshar + 
                   " Maghrib:" + this._adjustMaghrib + " Isya:" + this._adjustIsya);
        
        // Update location from settings
        this._locationName = this._cityName || "KOTA PONTIANAK";
        
        // Parse new coordinates
        this._parseCoordinates();
        
        // Re-fetch schedule with new location
        this._fetchPrayerSchedule();
    },

    _createMenu: function() {
        this.menu.removeAll();
        
        let header = new PopupMenu.PopupMenuItem(`📍 ${this._cityName || "Unknown"}`, { reactive: false });
        header.label.set_style("font-weight: bold; font-size: 14px;");
        this.menu.addMenuItem(header);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        if (this._prayerTimes && this._prayerTimes.length > 0) {
            for (let i = 0; i < this._prayerTimes.length; i++) {
                let prayer = this._prayerTimes[i];
                let isNext = (i === this._nextPrayerIndex);
                let isPast = (this._nextPrayerIndex !== -1 && i < this._nextPrayerIndex);
                let isTomorrow = prayer.isTomorrow || false;
                
                // Build time string
                let timeStr = prayer.timeStr;
                if (isTomorrow) {
                    timeStr += " (besok)";
                }
                if (prayer.adjustment && prayer.adjustment !== 0) {
                    let adjustSign = prayer.adjustment > 0 ? '+' : '';
                    timeStr += ` (${adjustSign}${prayer.adjustment})`;
                }
                
                // Create custom menu item with left-right alignment
                let menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
                menuItem.actor.add_style_class_name('prayer-row');
                
                // Left label - prayer name
                let nameLabel = new St.Label({
                    text: prayer.name,
                    style_class: 'prayer-name-label',
                    x_expand: true,
                    x_align: St.Align.START
                });
                
                // Right label - prayer time
                let timeLabel = new St.Label({
                    text: timeStr,
                    style_class: 'prayer-time-label',
                    x_expand: false,
                    x_align: St.Align.END
                });
                
                menuItem.addActor(nameLabel, { expand: true });
                menuItem.addActor(timeLabel, { expand: false, align: St.Align.END });
                
                if (prayer.adjustment && prayer.adjustment !== 0) {
                    menuItem.actor.add_style_class_name('prayer-adjusted');
                }
                
                if (isNext) {
                    menuItem.actor.add_style_class_name('prayer-next');
                } else if (isPast) {
                    menuItem.actor.add_style_class_name('prayer-past');
                }
                
                this.menu.addMenuItem(menuItem);
            }
        } else {
            let noDataItem = new PopupMenu.PopupMenuItem("Tidak ada data jadwal sholat", { reactive: false });
            this.menu.addMenuItem(noDataItem);
        }
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        let refreshItem = new PopupMenu.PopupMenuItem("🔄 Refresh Jadwal");
        refreshItem.connect('activate', Lang.bind(this, function() {
            this._fetchPrayerSchedule();
        }));
        this.menu.addMenuItem(refreshItem);
        
        let aboutItem = new PopupMenu.PopupMenuItem("ℹ️  Faghfirli - Jadwal Sholat");
        aboutItem.connect('activate', Lang.bind(this, function() {
            global.log("Faghfirli - Jadwal Sholat Pontianak");
        }));
        this.menu.addMenuItem(aboutItem);
    },

    on_applet_clicked: function(event) {
        this._createMenu();
        this.menu.toggle();
    },
    
    on_applet_removed_from_panel: function() {
        if (this._countdownTimer) {
            Mainloop.source_remove(this._countdownTimer);
        }
        if (this._fetchTimer) {
            Mainloop.source_remove(this._fetchTimer);
        }
        if (this._blinkTimer) {
            Mainloop.source_remove(this._blinkTimer);
        }
        
        if (this.settings) {
            this.settings.finalize();
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new MyApplet(metadata, orientation, panel_height, instance_id);
}
